/*
*'
* Copyright (C) 2011, The Locker Project
* All rights reserved.
*
* Please see the LICENSE file for more information.
*
*/

var fs = require('fs'),
    locker = require('../../Common/node/locker.js');
    
var lsearch = require('../../Common/node/lsearch');
var lutil = require('../../Common/node/lutil');

var lockerInfo = {};
exports.lockerInfo = lockerInfo;

var express = require('express'),
    connect = require('connect');
var request = require('request');
var async = require('async');
var app = express.createServer(connect.bodyParser());

app.set('views', __dirname);

app.get('/', function(req, res) {
    res.send('You should use a search interface instead of trying to talk to me directly.');
});

app.post('/events', function(req, res) {
    exports.handlePostEvents(req, function(err, response) {
        if (err) {
            return res.send(err, 500);
        }
        return res.send(response);
    });
});

app.post('/index', function(req, res) {
    exports.handlePostIndex(req, function(err, response) {
       if (err) {
           return res.send(err, 500);
       }
       return res.send(response);
   });
});

app.get('/query', function(req, res) {
    exports.handleGetQuery(req, function(err, response) {
       if (err) {
           return res.send(err, 500);
       }
       return res.send(response);
   });
});

exports.handlePostEvents = function(req, callback) {
    var error;
    
    if (req.headers['content-type'] !== 'application/json') {
        error = 'Expected content-type of "application/json" for /search/events POST request. Received content-type: ' + req.headers['content-type'];
        console.error(error);
        return callback(error, {});
    }
        
    if (!req.body) {
        error = 'Empty body received for /search/events POST request.';
        console.error(error);
        return callback(error, {});
    }
        
    var source = getSourceForEvent(req.body);
    
    if (req.body.type) {
        if (req.body.action === 'new' || req.body.action === 'update') {
            lsearch.indexTypeAndSource(req.body.type, source, req.body.obj.data, function(err, time) {
                if (err) { 
                    handleError(req.body.type, req.body.action, req.body.obj.data._id, err);
                }
                handleLog(req.body.type, req.body.action, req.body.obj.data._id, time);
                return callback(err, {timeToIndex: time, docsDeleted: 0});
            });
        } else if (req.body.action === 'delete') {
            lsearch.deleteDocument(req.body.obj.data._id, function(err, time, docsDeleted) {
                if (err) { 
                    handleError(req.body.type, req.body.action, req.body.obj.data._id, err); 
                }
                handleLog(req.body.type, req.body.action, req.body.obj.data._id, time);
                return callback(err, {timeToIndex: time, docsDeleted: docsDeleted});
            });
        } else {
            error = 'Invalid action received for /search/events POST request.';
            console.error(error);
            return callback(error, {});
        }
    } else {
        error = 'Unexpected event received for /search/events POST request: ' + req.body.type + ' and ' + req.body.action;
        console.error(error);
        return callback(error, {});
    }
};

exports.handlePostIndex = function(req, callback) {
    var error;
    if (!req.body.type || !req.body.value || !req.body.via || !req.body.obj.source) {
        error = 'Invalid arguments given for /search/index POST request.';
        console.error(error);
        return callback(error, {});
    }
    
    var value = {};
    
    try {
        value = JSON.parse(req.body.value);
    } catch (E) {
        error = 'Invalid JSON given in body for /search/index POST request.';
        console.error(error);
        return callback(error, {});
    }
    
    var source = getSourceForEvent(req.body);
    
    lsearch.indexTypeAndSource(req.body.type, source, value, function(err, time) {
        if (err) {
            error = '/search/index POST request was unable to index data: ' + error;
            console.error(error);
            return callback(error, {});
        }
        return callback(null, {timeToIndex: time, docsDeleted: 0});
    });
};

exports.handleGetQuery = function(req, callback) {
    var error;
    if (!req.param('q')) {
        error = 'Invalid arguments given for /search/query GET request.';
        console.error(error);
        return callback(error, {});
    }

    var q = lutil.trim(req.param('q'));
    var type;
    
    if (req.param('type')) {
        type = req.param('type');
    }

    if (!q || q.substr(0, 1) == '*') {
        error = 'Please supply a valid query string for /search/query GET request.';
        console.error(error);
        return callback(error, {});
    }

    function sendResults(err, results, queryTime) {
        if (err) {
            error = 'Error querying via /search/query GET request.';
            console.error(error);
            return callback(error, {});
        }

        enrichResultsWithFullObjects(results, function(err, richResults) {
            var data = {};
            data.took = queryTime;
        
            if (err) {
                data.error = err;
                data.hits = [];
                error = 'Error enriching results of /search/query GET request: ' + err;
                return callback(error, data);
            }
        
            data.error = null;
            data.hits = richResults;
            data.total = richResults.length;
            return callback(null, data);
        });       
    }
    
    if (type) {
        lsearch.queryType(type, q, {}, sendResults);
    } else {
        lsearch.queryAll(q, {}, sendResults);
    }
};

function enrichResultsWithFullObjects(results, callback) {
    // fetch full objects of results
    async.waterfall([
        function(waterfallCb) {
            cullAndSortResults(results, function(err, results) {
                waterfallCb(err, results);
            });
        },
        function(results, waterfallCb) {
            async.forEach(results, 
                function(item, forEachCb) {
                    var url = lockerInfo.lockerUrl + '/Me/' + item._source + '/' + item._id;
                    makeEnrichedRequest(url, item, forEachCb);
                }, 
                function(err) {
                    waterfallCb(err, results);
                }
            ); 
        }
    ],
    function(err, results) {        
        if (err) {  
            callback('Error when attempting to sort and enrich search results: ' + err, []);
        }
        callback(null, results);
    });
}

function cullAndSortResults(results, callback) {
    async.sortBy(results, function(item, sortByCb) {
        // we concatenate the score to the type, and we use the reciprocal of the score so the sort has the best scores at the top
        sortByCb(null, item._type + (1/item.score).toFixed(3));
    },
    function(err, results) {
       callback(null, results); 
    });
}

function makeEnrichedRequest(url, item, callback) {
    request.get({uri:url}, function(err, res, body) {
        if (err) {
            console.error('Error when attempting to enrich search results: ' + err);
            callback(err);
            return;
        } 
        if (res.statusCode >= 400) {
            var error = 'Received a ' + res.statusCode + ' when attempting to enrich search results';
            console.error(error);
            callback(error);
            return;
        }
        
        item.fullobject = body;
        callback(null);
    });
}

function getSourceForEvent(body) {
    // FIXME: This is a bad hack to deal with the tech debt we have around service type naming and eventing inconsistencies
    var splitVia = body.via.split('/');
    var splitSource = body.obj.source.split('_');
    var source = splitVia[1] + '/' + splitSource[1];
    if (body.type == 'contact/full' || body.type == 'photo/full') {
        var splitType = body.type.split('/');
        source = splitType[0] + 's';
    }
    return source;
    // END FIXME
}

function handleError(type, action, id, error) {
    console.error('Error attempting to ' + action + ' index of type "' + type + '" and id: ' + id + ' - ' + error);
}

function handleLog(type, action, id, time) {
    var actionWord;
    switch (action) {
        case 'new':
            actionWord = 'added';
            break;
        case 'update':
            actionWord = 'updated';
            break;
        case 'delete':
            actionWord = 'deleted';
            break;
    }
    console.log('Successfully ' + actionWord + ' ' + type + ' record in search index with id ' + id + ' in ' + time + 'ms');
}

// Process the startup JSON object
process.stdin.resume();
var allData = '';
process.stdin.on('data', function(data) {
    allData += data;
    if (allData.indexOf('\n') > 0) {
        data = allData.substr(0, allData.indexOf('\n'));
        lockerInfo = JSON.parse(data);
        locker.initClient(lockerInfo);
        if (!lockerInfo || !lockerInfo.workingDirectory) {
            process.stderr.write('Was not passed valid startup information.'+data+'\n');
            process.exit(1);
        }
        process.chdir(lockerInfo.workingDirectory);

        lsearch.setEngine(lsearch.engines.CLucene);
        lsearch.setIndexPath(process.cwd() + '/search.index');
        
        app.listen(lockerInfo.port, 'localhost', function() {
            process.stdout.write(data);
        });
    }
});
