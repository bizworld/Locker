/*
*
* Copyright (C) 2011, The Locker Project
* All rights reserved.
*
* Please see the LICENSE file for more information.
*
*/

var express = require('express'),
    connect = require('connect'),
    fs = require('fs'),
    url = require('url'),
    querystring = require('querystring'),
    sys = require('sys'),
    request = require('request'),
    locker = require('../../Common/node/locker.js'),
    lfs = require('../../Common/node/lfs.js'),
    authLib = require('./auth');


var requestCount;
var twitterClient;

var app = express.createServer(
        connect.bodyParser(),
        connect.cookieParser(),
        connect.session({secret : "locker"})
    );
    

var me, auth, latests, userInfo;

function addAll(target, anotherArray) {
    if(!target) 
        target = [];
    if(!anotherArray || !anotherArray.length)
        return;
    for(var i = 0; i < anotherArray.length; i++)
        target.push(anotherArray[i]);
}

app.get('/', handleIndex);

function handleIndex(req, res) {
    if(!(auth && auth.consumerKey && auth.consumerSecret && auth.token)) {
        res.redirect(me.uri + 'auth');
    } else {
        if(!twitterClient)
            twitterClient = require('./twitter_client')(auth.consumerKey, auth.consumerSecret, me.uri);   
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end("<html>great! now you can:<br><li><a href='home_timeline'>sync your timeline</a></li>" + 
                                             "<li><a href='mentions'>sync your mentions</a></li>" + 
                                             "<li><a href='friends'>sync your friends</a></li>" + 
                                              "<li><a href='followers'>sync your followers</a></li>" +
                                             "<li><a href='profile'>sync your profile</a></li>" +"</html>");
    }
    
}

function readStatuses(req, res, type) {
    lfs.readObjectsFromFile(type + '.json', function(data) {
        res.writeHead(200, {'Content-Type': 'application/json'});
        data.reverse();
        res.end(JSON.stringify(data));
    });
}

app.get('/get_home_timeline', function(req, res) {
    readStatuses(req, res, 'home_timeline');
});

app.get('/home_timeline', function(req, res) {
    pullStatuses('home_timeline', 60, res);
});

app.get('/get_mentions', function(req, res) {
    readStatuses(req, res, 'mentions');
});

app.get('/mentions', function(req, res) {
    pullStatuses('mentions', 120, res);
});

app.get('/rate_limit_status', function(req, res) {
    getRateLimitStatus(function(status) {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(status));
    });
});

function pullStatuses(endpoint, repeatAfter, res) {
    if(!getTwitterClient()) {
        sys.debug('could not get twitterClient');
        res.writeHead(401, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({error:'missing auth info :('}));
        return;
    }
    pullTimeline(endpoint, function(items) {
        res.writeHead(200, {'Content-Type': 'application/json'});
        locker.at(endpoint, repeatAfter);
        locker.diary("sync'd "+endpoint+" with "+items.length+" new entries");
        res.end(JSON.stringify({success:"got "+endpoint+" with "+items.length+" new entries" + 
                                " and scheduled to sync again in "+repeatAfter+" seconds, happy day"}));
    });
}

function pullTimeline(endpoint, callback) {
    if(!latests[endpoint])
        latests[endpoint] = {};
    var items = [];
    pullTimelinePage(endpoint, null, latests[endpoint].latest, null, items, function() {
        items.reverse();
        lfs.appendObjectsToFile(endpoint + '.json', items);
        callback(items);
    });
}

function pullTimelinePage(endpoint, max_id, since_id, page, items, callback) {
    if(!page)
        page = 1;
    var params = {token: auth.token, count: 200, page: page, include_entities:true};
    if(max_id)
        params.max_id = max_id;
    if(since_id)
        params.since_id = since_id;
    requestCount++;
    twitterClient.apiCall('GET', '/statuses/' + endpoint + '.json', params, 
        function(error, result) {
            if(error) {
                if(error.statusCode >= 500) { //failz-whalez, hang out for a bit
                    setTimeout(function(){pullTimelinePage(endpoint, max_id, since_id, page, items, callback);}, 10000);
                }
                sys.debug('error from twitter:' + sys.inspect(error));
                return;
            }
            if(result.length > 0) {
                var id = result[0].id;
                if(!latests[endpoint].latest || id > latests[endpoint].latest)
                    latests[endpoint].latest = id;
                for(var i = 0; i < result.length; i++)
                    items.push(result[i]);

                if(!max_id)
                    max_id = result[0].id;
                page++;
                if(requestCount > 300) {
                    sys.debug('sleeping a bit...');
                    setTimeout(function() {
                        pullTimelinePage(endpoint, max_id, since_id, page, items, callback);
                    }, 30000);
                } else {
                    pullTimelinePage(endpoint, max_id, since_id, page, items, callback);
                }
            } else if(callback) {
                lfs.writeObjectToFile('latests.json', latests);
                callback();
            }
        });
}

app.get('/friends', function(req, res) {
    syncUsersInfo('friends', req, res);
});

app.get('/allContacts', function(req, res) {
    lfs.readObjectsFromFile('friends.json', function(frnds) {
        var friends = frnds;
        var allContacts = {};
        for(var i in friends) {
            var friend = friends[i];
            if(!friend)
                continue;
            friend.isFriend = true;
            allContacts[friend.screen_name] = friend;
        }
        lfs.readObjectsFromFile('followers.json', function(fllwrs) {
            var followers = fllwrs;
            for(var j in followers) {
                var follower = followers[j];
                if(!follower)
                    continue;
                if(allContacts[follower.screen_name]) {
                    allContacts[follower.screen_name].isFollower = true;
                } else {
                    follower.isFollower = true;
                    allContacts[follower.screen_name] = follower;
                }
            }
            var arr = [];
            for(var k in allContacts)
                arr.push(allContacts[k]);
            res.writeHead(200, {'content-type' : 'application/json'});
            res.end(JSON.stringify(arr));
        });
    });
});

app.get('/followers', function(req, res) {
    syncUsersInfo('followers', req, res);
});

function syncUsersInfo(friendsOrFollowers, req, res) {
    if(!friendsOrFollowers || friendsOrFollowers.toLowerCase() != 'followers')
        friendsOrFollowers = 'friends';
        
    function done() {    
        locker.at('/' + friendsOrFollowers, 3600);
        res.writeHead(200, {'content-type':'application/json'});
        res.end(JSON.stringify({success:"done fetching "+friendsOrFollowers}));
    }
    getUserInfo(function(err, newUserInfo) {
        userInfo = newUserInfo;
        lfs.writeObjectToFile('usersInfo.json', userInfo);
        getIDs(friendsOrFollowers, userInfo.screen_name, function(err, ids) {
            if(!ids || ids.length < 1)
                done();
            else
                getUsersExtendedInfo(ids, function(usersInfo) {
                    locker.diary('got ' + usersInfo.length + ' ' + friendsOrFollowers);
                    lfs.writeObjectsToFile(friendsOrFollowers + '.json', usersInfo);
                    done();
                });
        });
    });
}

app.get('/profile', function(req, res) {
    getUserInfo(function(err, newUserInfo) {
        userInfo = newUserInfo;
        lfs.writeObjectToFile('userInfo.json', userInfo);
        res.writeHead(200, {'content-type':'application/json'});
        res.end(JSON.stringify({success:userInfo}));
    });
});

function getUserInfo(callback) {
    if(!getTwitterClient())
        return;
    twitterClient.apiCall('GET', '/account/verify_credentials.json', {token:auth.token, include_entities:true}, callback);
}


function getIDs(friendsOrFolowers, screenName, callback) {
    if(!friendsOrFolowers || friendsOrFolowers.toLowerCase() != 'followers')
        friendsOrFolowers = 'friends';
    friendsOrFolowers = friendsOrFolowers.toLowerCase();
    twitterClient.apiCall('GET', '/' + friendsOrFolowers + '/ids.json', 
                    {screen_name:screenName, cursor:-1, token: auth.token}, function(err, result) {
        if(err) {
            callback(err, result);
        } else {
            callback(null, result.ids);
        }
    });
}

/** returns object with:
 *  remaining_hits (api call remaining),
 *  hourly_limit (total allowed per hour), 
 *  reset_time (time stamp), 
 *  reset_time_in_seconds (unix time in secs)
 */
function getRateLimitStatus(callback) {
    request.get({uri:'http://api.twitter.com/1/account/rate_limit_status.json'}, function(err, resp, body) {
        var limits = JSON.parse(body);
        var remainingTime = limits.reset_time_in_seconds - (new Date().getTime() / 1000);
        if(limits.remaining_hits)
            limits.sec_between_calls = remainingTime / limits.remaining_hits;
        else
            limits.sec_between_calls = remainingTime / 1;
        callback(limits);
    });
}

function getUsersExtendedInfo(userIDs, callback) {
    _getUsersExtendedInfo(userIDs, [], callback);
}

function _getUsersExtendedInfo(userIDs, usersInfo, callback) {
    if(!usersInfo)
        usersInfo = [];
    var id_str = "";
    for(var i = 0; i < 100 && userIDs.length > 0; i++) {
        id_str += userIDs.pop();
        if(i < 99) id_str += ',';
    }
    twitterClient.apiCall('GET', '/users/lookup.json', {token: auth.token, user_id: id_str, include_entities: true},
        function(error, result) {
            if(error) {
                sys.debug('error! ' + JSON.stringify(error));
                return;
            }
            addAll(usersInfo, result.reverse());
            if(userIDs.length > 0) 
                _getUsersExtendedInfo(userIDs, usersInfo, callback);
            else if(callback) {
                getPhotos(usersInfo);
                callback(usersInfo);
            }
        });
}

function getPhotos(users) {
    try {
        fs.mkdirSync('photos', 0755);
    } catch(err) {
    }
    var userz = [];
    for(var i in users)
        userz.push(users[i]);
    
    function _curlNext() {
        var user = userz.pop();
        if(!user)
            return;
        var photoExt = user.profile_image_url.substring(user.profile_image_url.lastIndexOf('/')+1);
        lfs.curlFile(user.profile_image_url, 'photos/' + user.id_str + photoExt, function(success) {
            _curlNext();
        });
    }
    _curlNext();
}

function getTwitterClient() {
    if(!twitterClient && auth && auth.consumerKey && auth.consumerSecret)
        twitterClient = require('./twitter_client')(auth.consumerKey, auth.consumerSecret);
    return twitterClient;
}

function clearCount() {
    requestCount = 0;
    setTimeout(clearCount, 3600000);
}
clearCount();

var stdin = process.openStdin();
stdin.setEncoding('utf8');
stdin.on('data', function (chunk) {
    var processInfo = JSON.parse(chunk);
    locker.initClient(processInfo);
    process.chdir(processInfo.workingDirectory);
    me = lfs.loadMeData();
    lfs.readObjectFromFile('auth.json', function(storedAuth) {
        authLib.init(me.uri, storedAuth, app, function(newAuth, req, res) {
            auth = newAuth;
            lfs.writeObjectToFile('auth.json', auth);
            if(req, res)
                handleIndex(req, res);
        });
        lfs.readObjectFromFile('latests.json', function(newLatests) {
            latests = newLatests;
            lfs.readObjectFromFile('userInfo.json', function(newUserInfo) {
                userInfo = newUserInfo;
                app.listen(processInfo.port);
                var returnedInfo = {port: processInfo.port};
                console.log(JSON.stringify(returnedInfo));
            });
        });
    });
});
