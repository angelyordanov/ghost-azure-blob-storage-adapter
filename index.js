'use strict';

// # Azure blob storage module for Ghost blog http://ghost.org/

var requireFromGhost = function(module, blocking) {
    try {
        return require('ghost/' + module);
    } catch (e) {
        if (e.code !== 'MODULE_NOT_FOUND') throw e;
        try {
            return require(path.join(process.cwd(), module));
        } catch (e) {
            if (e.code !== 'MODULE_NOT_FOUND' || blocking) throw e;
            return null;
        }
    }
};

var path = require('path'),
    util = require('util'),
    azure = require('azure-storage'),
    Promise = require('bluebird'),
    BaseStore = requireFromGhost("core/server/storage/base", false),
    LocalFileStore = requireFromGhost("core/server/storage/local-file-store", false),
    protocol = 'https',
    domain = 'blob.core.windows.net';

function AzureBlobStore(config) {
    if (BaseStore) BaseStore.call(this);
    this.config = config || {};
    this.config.storageAccount = this.config.storageAccount || process.env.AZURE_STORAGE_ACCOUNT;
    this.config.accessKey = this.config.accessKey || process.env.AZURE_STORAGE_ACCESS_KEY;
    this.blobSvc = null;
}

if (BaseStore) util.inherits(AzureBlobStore, BaseStore);

AzureBlobStore.prototype.initBlobService = function() {
    if (!!this.config.storageAccount &&
        !!this.config.accessKey &&
        !!this.config.container) {
        if (!this.blobSvc) {
            var blobSvc = azure.createBlobService(this.config.storageAccount, this.config.accessKey);
            this.createContainerIfNotExists = Promise.promisify(blobSvc.createContainerIfNotExists, { context: blobSvc });
            this.createBlockBlobFromLocalFile = Promise.promisify(blobSvc.createBlockBlobFromLocalFile, { context: blobSvc });
            this.getBlobProperties = Promise.promisify(blobSvc.getBlobProperties, { context: blobSvc, multiArgs: true });
            this.deleteBlob = Promise.promisify(blobSvc.deleteBlob, { context: blobSvc });

            this.blobSvc = blobSvc;
        }
        return this.blobSvc;
    }
    throw Error('ghost-azure-blob-storage is not configured');
};

// Implement BaseStore::save(image, targetDir)
AzureBlobStore.prototype.save = function(image, targetDir) {
    var self = this;

    targetDir = targetDir || this.getTargetDir();

    try {
        this.initBlobService();
    } catch (error) {
        return Promise.reject(error.message);
    }

    var filename;
    return this.getUniqueFileName(this, image, targetDir)
        .then(function(result) {
            filename = result;
        })
        .then(function () {
            return self.createContainerIfNotExists(self.config.container, { publicAccessLevel: 'blob' });
        })
        .then(function () {
            return self.createBlockBlobFromLocalFile(self.config.container, filename, image.path);
        })
        .tap(function() {
            console.log('ghost-azure-blob-storage', 'Temp uploaded file path: ' + image.path);
        })
        .then(function() {
            var url = protocol + '://' + self.config.storageAccount + '.' + domain + '/' + self.config.container + '/' + filename;
            return Promise.resolve(url);
        })
        .catch(function(err) {
            console.error('ghost-azure-blob-storage', err);
            throw err;
        });
};

// Implement BaseStore::save(filename)
AzureBlobStore.prototype.exists = function(filename) {
    try {
        this.initBlobService();
    } catch (error) {
        return Promise.reject(error.message);
    }

    return this.getBlobProperties(this.config.container, filename)
        .spread(function(properties, status) {
            return Promise.resolve(status.isSuccessful);
        })
        .catch(function(err) {
            if (err.statusCode === 404) {
                return Promise.resolve(false);
            }
            return Promise.reject(err);
        });
};

// Implement BaseStore::serve(options)
// middleware for serving the files
AzureBlobStore.prototype.serve = function(options) {
    options = options || {};

    // Preserve Theme download functionality
    if (options.isTheme) {
        if (LocalFileStore) {
            return (new LocalFileStore()).serve(options);
        }
        return function(req, res, next) {
            res.send(404);
        };
    }

    try {
        this.initBlobService();
    } catch (err) {
        return function(req, res, next) {
            console.error("ghost-azure-blob-storage", err);
            res.send(500);
        };
    }

    return function (req, res, next) {
        var filepath = req.path.replace(/^\//, '');

        return this.getBlobProperties(this.config.container, filepath)
            .spread(function(properties, status) {
                if (!status.isSuccessful) {
                    res.send(404);
                } else {
                    res.header('Content-Type', properties.contentType);
                    self.blobSvc.createReadStream(this.config.container, filepath)
                        .on('error', function(err) {
                            console.error("ghost-azure-blob-storage", err);
                            res.send(500);
                        })
                        .pipe(res);
                }
            })
            .catch(function(err) {
                if (err.statusCode === 404) {
                    res.send(404);
                } else {
                    console.error("ghost-azure-blob-storage", err);
                    res.send(500);
                }
            });
    };
};

// Implement BaseStore::delete(filename, targetDir)
AzureBlobStore.prototype.delete = function(filename, targetDir) {
    targetDir = targetDir || this.getTargetDir();

    var filepath = path.join(targetDir, filename);

    try {
        this.initBlobService();
    } catch (error) {
        return Promise.reject(error.message);
    }

    return this.deleteBlob(this.config.container, filepath)
        .tap(function() {
            console.log('ghost-azure-blob-storage', 'Deleted file: ' + filepath);
        })
        .then(function() {
            return Promise.resolve(true);
        })
        .catch(function(err) {
            console.error("ghost-azure-blob-storage", err);
            return Promise.resolve(false);
        });
};

module.exports = AzureBlobStore;
