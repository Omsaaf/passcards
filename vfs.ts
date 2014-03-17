/// <reference path="typings/node/node.d.ts" />

var fs = require('fs');
var Path = require('path');
var dropbox = require('dropbox');

/** Holds details of a file retrieved by a VFS implementation */
export class FileInfo {
	name: string;
	path: string;
	isDir: boolean;
}

/** Interface for async file system access.
 */
export interface VFS {
	/** Logs in to the VFS service */
	login(cb: (error:any, account: string) => any);
	/** Returns true if the user is logged in */
	isLoggedIn(): boolean;
	/** Returns credentials for the logged in account.
	 * This is an opaque object which can later be restored.
	 */
	credentials() : Object;
	/** Sets the login credentials */
	setCredentials(credentials : Object);

	/** Search for files whose name contains @p namePattern */
	search(namePattern: string, cb: (files: FileInfo[]) => any);
	/** Read the contents of a file at @p path */
	read(path: string, cb: (error: any, content:string) => any);
	/** Write the contents of a file at @p path */
	write(path: string, content: string, cb: (error:any) => any);
	/** List the contents of a directory */
	list(path: string, cb: (error: any, files: FileInfo[]) => any);
	/** Remove a file */
	rm(path: string, cb: (error: any) => any);
}

/** VFS implementation which operates on the local filesystem */
export class FileVFS implements VFS {
	root : string;

	constructor(_root: string) {
		this.root = _root;
	}

	searchIn(path: string, namePattern: string, cb: (files: FileInfo[]) => any) {
		this.list(path, (error, files: FileInfo[]) => {
			files.forEach((file : FileInfo) => {
				if (file.name.indexOf(namePattern) != -1) {
					cb([file]);
				}

				if (file.isDir) {
					this.searchIn(file.path, namePattern, cb);
				}
			});
		});
	}

	search(namePattern: string, cb: (files: FileInfo[]) => any) {
		this.searchIn('', namePattern, cb);
	}

	read(path: string, cb: (error: any, content:string) => any) {
		fs.readFile(this.absPath(path), cb);
	}

	write(path: string, content: string, cb: (error:any) => any) {
		fs.writeFile(this.absPath(path), content, cb)
	}

	list(path: string, cb: (error: any, files: FileInfo[]) => any) {
		var absPath : string = this.absPath(path);
		fs.readdir(absPath, (err, files: string[]) => {
			if (err) {
				console.log('Unable to read dir ' + absPath);
				return;
			}

			var done = 0;
			var infoList : FileInfo[] = [];
			files.forEach((name : string) => {
				var filePath : string = Path.join(absPath, name);
				fs.stat(filePath, (err, info) => {
					if (err) {
						console.log('Unable to stat ' + filePath);
						return;
					}

					var fi = new FileInfo;
					fi.name = name;
					fi.path = filePath;
					fi.isDir = info.isDirectory();

					infoList.push(fi);
					++done;
					if (done == files.length) {
						cb(null, infoList);
					}
				});
			});
		});
	}

	rm(path: string, cb: (error: any) => any) {
		fs.unlink(this.absPath(path), cb);
	}

	login(cb: (error:any, account: string) => any) {
		cb(null, '');
	}

	isLoggedIn() : boolean {
		return true;
	}

	credentials() : Object {
		return {};
	}

	setCredentials(credentials : Object) {
		// unused
	}

	private absPath(path: string) : string {
		if (path.indexOf(this.root) != 0) {
			return Path.join(this.root, path);
		} else {
			return path;
		}
	}
}

