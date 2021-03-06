import * as vs from 'vscode';
import {FileInfo} from './FileInfo';
import * as minimatch from 'minimatch';
import PathConfiguration from './PathConfiguration';

// node modules
import * as fs from 'fs';
import * as path from 'path';

var configuration = new PathConfiguration();

// load the initial configurations
configuration.update();

export class PathAutocomplete implements vs.CompletionItemProvider {

    currentFile: string;

    provideCompletionItems(document: vs.TextDocument, position: vs.Position, token: vs.CancellationToken): Thenable<vs.CompletionItem[]> {
        var currentLine = document.getText(document.lineAt(position).range);
        var self = this;

        configuration.update(document.uri);

        this.currentFile = document.fileName;
 
        if (!this.shouldProvide(currentLine, position.character)) {
            return Promise.resolve([]);
        }

        var folderPath = this.getFolderPath(document.fileName, currentLine, position.character);

        if (!fs.existsSync(folderPath) || !fs.lstatSync(folderPath).isDirectory()) {
            return Promise.resolve([]);
        }

        return this.getFolderItems(folderPath).then((items: FileInfo[]) => {
            // build the list of the completion items
            var result = items.filter(self.filter, self).map((file) => {
                var completion = new vs.CompletionItem(file.getName());

                completion.insertText = this.getInsertText(file);

                // show folders before files
                if (file.isDirectory()) {
                    completion.label += '/';

                    if (configuration.data.enableFolderTrailingSlash) {
                        completion.command = {
                            command: 'default:type',
                            title: 'triggerSuggest',
                            arguments: [{
                                text: '/'
                            }]
                        };
                    }

                    completion.sortText = 'd';
                } else {
                    completion.sortText = 'f';
                }

                completion.kind = vs.CompletionItemKind.File;

                return completion;
            });

            // add up one folder item
            result.unshift(new vs.CompletionItem('..'))

            return Promise.resolve(result);
        });
    }

    getInsertText(file: FileInfo): string {
        var insertText = '';
        if (configuration.data.withExtension || file.isDirectory()) {
            insertText = path.basename(file.getName());
        } else {
            // remove the extension
            insertText = path.basename(file.getName(), path.extname(file.getName()));
        }

        // apply the transformations
        configuration.data.transformations.forEach((transform) => {
            var fileNameRegex = transform.when && transform.when.fileName && new RegExp(transform.when.fileName);
            if (fileNameRegex && !file.getName().match(fileNameRegex)) {
                return;
            }

            var parameters = transform.parameters || [];
            if (transform.type == 'replace' && parameters[0]) {
                insertText = String.prototype.replace.call(insertText, new RegExp(parameters[0]), parameters[1]);
            }

        });

        return insertText;
    }


    /**
     * Builds a list of the available files and folders from the provided path.
     */
    getFolderItems(folderPath: string) {
        return new Promise(function(resolve, reject) {
            fs.readdir(folderPath, function(err, items) {
                if (err) {
                    return reject(err);
                }
                var results = [];

                items.forEach(item => {
                    try {
                        results.push(new FileInfo(path.join(folderPath, item)));
                    } catch (err) {
                        // silently ignore permissions errors
                    }
                });

                resolve(results);
            });
        });
    }

    /**
     * Builds the current folder path based on the current file and the path from
     * the current line.
     * 
     */
    getFolderPath(fileName: string, currentLine: string, currentPosition: number): string {

        var userPath = this.getUserPath(currentLine, currentPosition);
        var mappingResult = this.applyMapping(userPath);
        var insertedPath = mappingResult.insertedPath;
        var currentDir = mappingResult.currentDir || this.getCurrentDirectory(fileName, insertedPath);

        // relative to the disk
        if (insertedPath.match(/^[a-z]:/i)) {
            return path.resolve(insertedPath);
        }

        // user folder
        if (insertedPath.startsWith('~')) {
            return path.join(configuration.data.homeDirectory, insertedPath.substring(1));
        }

        // npm package
        if (this.isNodePackage(insertedPath, currentLine)) {
            return path.join(this.getNodeModulesPath(currentDir), insertedPath);
        }

        return path.join(currentDir, insertedPath);
    }

    /**
     * Retrieves the path inserted by the user. This is taken based on the last quote or last white space character.
     * 
     * @param currentLine The current line of the cursor.
     * @param currentPosition The current position of the cursor.
     */
    getUserPath(currentLine: string, currentPosition: number): string {
        var lastQuote = -1;
        var lastSeparator = -1;

        for (var i = 0; i < currentPosition; i++) {
            var c = currentLine[i];

            // skip next character if escaped
            if (c == "\\") {
                i++;
                continue;
            }

            // handle space, tabs and ( for support outside strings
            if (c == " " || c == "\t" || c == '(' || c == '{' || c == '[') {
                lastSeparator = i;
                continue;
            }

            // handle quotes
            if (c == "'" || c == '"' || c == "`") {
                lastQuote = i;
            }
        }

        var startPosition = (lastQuote != -1) ? lastQuote : lastSeparator;

        return currentLine.substring(startPosition + 1, currentPosition);
    }

    /**
     * Searches for the node_modules folder in the parent folders of the current directory.
     *
     * @param currentDir The current directory
     */
    getNodeModulesPath(currentDir: string): string {
        var rootPath = configuration.data.workspaceFolderPath;

        while (currentDir != path.dirname(currentDir)) {
            console.log(currentDir);
            var candidatePath = path.join(currentDir, 'node_modules');
            if (fs.existsSync(candidatePath)) {
                return candidatePath;
            }

            currentDir = path.dirname(currentDir);
        }

        return path.join(rootPath, 'node_modules');
    }

    /**
     * Returns the current working directory
     */
    getCurrentDirectory(fileName: string, insertedPath: string): string {
        var currentDir = path.parse(fileName).dir || '/';
        var workspacePath = configuration.data.workspaceFolderPath;

        // based on the project root
        if (insertedPath.startsWith('/') && workspacePath) {
            currentDir = workspacePath;
        }

        return path.resolve(currentDir);
    }

    /**
     * Applies the folder mappings based on the user configurations
     */
    applyMapping(insertedPath: string): { currentDir: string, insertedPath: string } {
        var currentDir = '';
        var workspaceFolderPath = configuration.data.workspaceFolderPath;
        var workspaceRootPath = configuration.data.workspaceRootPath;

        Object.keys(configuration.data.pathMappings || {})
            .map((key) => {
                var candidatePath = configuration.data.pathMappings[key];

                if (workspaceRootPath) {
                    candidatePath = candidatePath.replace('${workspace}', workspaceRootPath);
                }

                if (workspaceFolderPath) {
                    candidatePath = candidatePath.replace('${folder}', workspaceFolderPath);
                }

                candidatePath = candidatePath.replace('${home}', configuration.data.homeDirectory);

                return {
                    key: key,
                    path: candidatePath
                };
            })
            .some((mapping) => {
                if (insertedPath.startsWith(mapping.key) || mapping.key === '$root') {
                    currentDir = mapping.path;
                    insertedPath = insertedPath.replace(mapping.key, '');
                    return true;
                }

                return false;
            });

        return { currentDir, insertedPath };
    }

    /**
     * Determine if the current path
     */
    isNodePackage(insertedPath: string, currentLine: string) {
        if (!currentLine.match(/require|import/)) {
            return false;
        }

        if (!insertedPath.match(/^[a-z]/i)) {
            return false;
        }

        return true;
    }

    /**
     * Determine if we should provide path completion.
     */
    shouldProvide(currentLine: string, position: number) {
        if (configuration.data.triggerOutsideStrings) {
            return true;
        }

        var quotes = {
            single: 0,
            double: 0,
            backtick: 0
        };

        // check if we are inside quotes
        for (var i = 0; i < position; i++) {
            if (currentLine.charAt(i) == "'" && currentLine.charAt(i-1) != '\\') {
                quotes.single += quotes.single > 0 ? -1 : 1;
            }

            if (currentLine.charAt(i) == '"' && currentLine.charAt(i-1) != '\\') {
                quotes.double += quotes.double > 0 ? -1 : 1;
            }

            if (currentLine.charAt(i) == '`' && currentLine.charAt(i-1) != '\\') {
                quotes.backtick += quotes.backtick > 0 ? -1 : 1;
            }
        }

        return !!(quotes.single || quotes.double || quotes.backtick);
    }

    /**
     * Filter for the suggested items
     */
    filter(file: FileInfo) {
        // no options configured
        if (!configuration.data.excludedItems || typeof configuration.data.excludedItems != 'object') {
            return true;
        }

        var currentFile = this.currentFile;
        var valid = true;

        Object.keys(configuration.data.excludedItems).forEach(function(item) {
            var rule = configuration.data.excludedItems[item].when;

            if (minimatch(currentFile, rule) && minimatch(file.getPath(), item)) {
                valid = false;
            }
        });

        return valid;
    }
}
