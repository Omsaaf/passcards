import node_vfs = require('./node');
import testLib = require('../test');
import vfs_util = require('./util');

import asyncutil = require('../base/asyncutil');

var fs_extra = require('fs-extra');

testLib.addTest('mktemp', assert => {
    const TEST_DIR = `${testLib.tempDir()}/vfs-util-test`;
    const ITER_COUNT = 10;

    fs_extra.emptyDirSync(TEST_DIR);
    var fs = new node_vfs.FileVFS(TEST_DIR);
    var count = 0;

    return asyncutil.until(() => {
        ++count;
        return vfs_util
            .mktemp(fs, '/', 'tmp.XXX')
            .then((path: string) => {
                assert.ok(path.match(/\/tmp.[a-z]{3}/) !== null);
            })
            .then(() => count > ITER_COUNT);
    });
});
