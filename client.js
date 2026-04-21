var version = '1.28';

var args = process.argv.slice(2);

var httpServer = 'http://192.168.81.179:8080';
var socketServer = 'http://192.168.81.179:3000/';
if (typeof args[0] != 'undefined') {		
    socketServer = 'http://' + args[0];		
}
if (typeof args[1] != 'undefined') {		
    httpServer = 'http://' + args[1];		
}

var spawn = require('child_process').spawn;
var exec  = require('child_process').exec;
var childProcess;

var path = require('path');

var socket = require('socket.io-client')(socketServer);

var fs = require('fs');
var fsp = require('fs').promises;

var FormData = require('form-data');
var request  = require('request');

var os = require('os');

// Random name generator
var marvel = require('marvel-characters')

var lastReceiveTime;
var photoStartTime;
var takeId;
var updateInProgress = false;

var imagePath = '/';
var imageName = 'output.jpg';

var focusFilePath = path.join(__dirname, 'focus_value.json');
var deviceNamePath = path.join(__dirname, "/device-name");

var cameraName = null;
var ipAddress  = null;
var hostName   = null;
var previewProcess;
var recordingStatus = 'idle';
var gitCommit = 'unknown';

function fetchGitCommit() {
    try {
        var gitDir = path.join(__dirname, '.git');
        var head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
        var sha = null;
        if (head.indexOf('ref: ') === 0) {
            var refName = head.substring(5);
            var looseRef = path.join(gitDir, refName);
            if (fs.existsSync(looseRef)) {
                sha = fs.readFileSync(looseRef, 'utf8').trim();
            } else {
                var packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
                var m = packed.match(new RegExp('^([a-f0-9]{40}) ' + refName + '$', 'm'));
                if (m) sha = m[1];
            }
        } else {
            sha = head;
        }
        if (sha) {
            gitCommit = sha.substring(0, 7);
            console.log('Running commit:', gitCommit);
        }
    } catch (err) {
        console.log('Could not determine git commit:', err.message);
    }
}

function boot() {
    console.log("Starting");

    hostName = os.hostname();

    fetchGitCommit();

    // Lookup our IP address
    lookupIp();
    
    // Set the device name, either a default or from storage
    cameraName = marvel();
    fs.readFile(deviceNamePath, function(err, buffer){
        if (typeof buffer == 'undefined') {
            return;
        }
        var savedName = buffer.toString();
        if (savedName) {
            cameraName = savedName;
            console.log('saved device name', cameraName);
        }
    });
    
    console.log("Startup complete");
}

async function loadFocusValue() {
    try {
        const data = await fsp.readFile(focusFilePath, 'utf8');
        const focusData = JSON.parse(data);
        return focusData.focusValue;
    } catch (err) {
        console.log(err);
        console.log("No saved focus value found");
        return null;
    }
}

function saveFocusValue(focusValue) {
    const focusData = { focusValue: focusValue };
    fsp.writeFile(focusFilePath, JSON.stringify(focusData))
        .then(() => {
            console.log('Focus value saved:', focusValue);
        })
        .catch((err) => {
            console.error('Failed to save focus value:', err);
        });
}

function applyFocusValue(focusValue, callback) {
    const pythonFocusProcess = spawn('python3', ['update_focus.py', focusValue]);

    pythonFocusProcess.stdout.on('data', (data) => {
        console.log(`stdout: ${data}`);
    });

    pythonFocusProcess.stderr.on('data', (data) => {
        console.error(`stderr: ${data}`);
    });

    pythonFocusProcess.on('close', (code) => {
        console.log(`child process exited with code ${code}`);
        if (typeof callback === 'function') {
            callback();
        }
    });}

socket.on('connect', function(){
    console.log('A socket connection was made');
    
    socket.emit('camera-online', {name: cameraName, ipAddress: ipAddress, version: version, commit: gitCommit, status: recordingStatus});

    // Setup a regular heartbeat interval
    var heartbeatIntervalID = setInterval(heartbeat, 3000);
});



socket.on('take-photo', async function(data){
    console.log("Taking a photo with command: ", data.command);  // Log the command received
    //const focusValue = await loadFocusValue();
    const focusValue = null;
    photoStartTime  = Date.now();
    lastReceiveTime = data.time;
    takeId          = data.takeId;
    
    let customCommand = '';
    if (data.customCommands && data.customCommands[socket.id]) {
        customCommand = data.customCommands[socket.id];
    }
    console.log("Taking a photo with command: ", customCommand);
    
    takeImage(focusValue, data.command,customCommand);  // Pass the command to the takeImage function
});

socket.on('take-video', (data) => {
    const msg = data || {};
    console.log('Video recording requested, payload:', msg);

    recordVideo({
        cameraId: msg.takeId,
        duration: msg.duration || 10000,
        framerate: msg.framerate || 24,
        customCommand: (msg.customCommands && msg.customCommands[socket.id]) || null,
        takeId: msg.takeId
    });
});


socket.on('update-software', function(data){
    console.log("Updating software");
    
    updateInProgress = true;

    updateSoftware();
});

socket.on('update-name', function(data){
    
    // Name updates go to all devices so only respond if its comes with the devices ip address
    if (data.ipAddress != ipAddress) {
        return;
    }
        
    // If we have a proper name update the camera name, if its being reset switch back to a marvel character
    if (data.newName) {
        cameraName = data.newName;
    } else {
        cameraName = marvel();
    }

    fs.writeFile(deviceNamePath, cameraName, function(err) {
        if (err) {
            console.log("Error saving the device name");
        }
    });
});

socket.on('preview', function(data) {
    console.log("Starting preview...");

    if (previewProcess) {
        previewProcess.kill();
    }
    
    previewProcess = spawn('python3', ['camera_stream.py']);

    previewProcess.stderr.on('data', (data) => {
        console.error(`stderr: ${data}`);
    });

    previewProcess.on('close', (code) => {
        console.log(`child process exited with code ${code}`);
    });

    socket.emit('preview-url', 'http://' + ipAddress + ':8888');
});

socket.on('stop-preview', function() {
    console.log("Stopping preview...");
    if (previewProcess) {
        previewProcess.kill();
    }
});

socket.on('update-focus', function(data) {
    console.log(`Updating focus to ${data.focusValue}`);
    saveFocusValue(data.focusValue);
});

function heartbeat() {
    if (ipAddress == null) {
        lookupIp();
    }
    socket.emit('camera-online', {name: cameraName, ipAddress: ipAddress, hostName: hostName, version: version, commit: gitCommit, updateInProgress: updateInProgress, status: recordingStatus});
}

function getAbsoluteImagePath() {
    return path.join(__dirname, imagePath, imageName);
}

function getAbsoluteVideoPath() {
    const videoDir = path.join(__dirname, '/');
    console.log('Video directory:', videoDir);
    const fileName = `video.mp4`;
    return path.join(videoDir, fileName);
}

function recordVideo(opts) {
    const { duration, framerate, customCommand, takeId } = opts || {};
    let args = [
        '--width', 1920,
        '--height', 1080,
        '--camera', 0,
        '-b', 90000000,
        '-t', duration || 10000,
        '--framerate', framerate || 24,
        '-o', getAbsoluteVideoPath()
    ];

    if (customCommand) {
        const customCommandArgs = customCommand.split(' ');
        args = args.concat(customCommandArgs);
    }

    console.log('Recording video with args:', args.join(' '));

    recordingStatus = 'recording';
    process.env.HOME = require('os').homedir();
    childProcess = exec('cd ' + __dirname + '; libcamera-vid ' + args.join(' '), function (error, stdout, stderr) {
        console.log('stdout: ' + stdout);
        console.log('stderr: ' + stderr);
        if (error !== null) {
            console.log('exec error: ' + error);
        }
        console.log("record complete, takeId:", takeId);
        sendVideo(getAbsoluteVideoPath(), takeId, takeId);
        recordingStatus = 'idle';
    });
}


function sendVideo(videoPath, takeId,cameraId) {
    // Check if the recording was successful
    console.log('Sending video:', videoPath);
    if (!fs.existsSync(videoPath)) {
        socket.emit('recording-error', { takeId: takeId, cameraId: cameraId });
        return;
    }

    socket.emit('sending-video', { takeId: takeId });

    const fileName = path.basename(videoPath); // Extract the file name from the path
    const form = new FormData();
    takeId = guid();
    console.log('takeId:', takeId);
    form.append('takeId', takeId);
    form.append('cameraId', takeId);
    form.append('fileName', fileName);
    form.append('video', fs.createReadStream(videoPath));
    console.log('takeIddone:', takeId);
    // Upload the video to the server
    form.submit(httpServer + '/new-image', function (err, res) {
        if (err) {
            console.error("Error uploading video:", err);
            socket.emit('recording-error', { takeId: takeId, cameraId: cameraId });
        } else {
            console.log("Video uploaded successfully");
        }

        // Delete the temporary video file
        fs.unlink(videoPath, function () {
            console.log("Temporary video file deleted:", videoPath);
        });

        if (res) res.resume();
    });

    // Emit event with metadata
    socket.emit('new-video', {
        takeId: takeId,
        cameraId: cameraId,
        fileName: fileName,
        time: Date.now()
    });
}



function lookupIp() {
    var ifaces = os.networkInterfaces();
    Object.keys(ifaces).forEach(function (ifname) {
        ifaces[ifname].forEach(function (iface) {
            if ('IPv4' === iface.family && iface.internal === false) {
                ipAddress = iface.address;
            }
        });
    });
}

function emitPhotoError(stage, extra) {
    var payload = {
        takeId: takeId,
        cameraName: cameraName,
        hostName: hostName,
        stage: stage
    };
    if (extra) {
        Object.keys(extra).forEach(function (k) { payload[k] = extra[k]; });
    }
    console.log('photo-error:', JSON.stringify(payload));
    socket.emit('photo-error', payload);
}

function sendImage(code, signal, stderrText, timedOut) {
    if (code !== 0 || timedOut) {
        var tail = (stderrText || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean).slice(-3).join(' | ');
        var reason = timedOut
            ? 'libcamera-still killed after 10s timeout'
            : (tail || ('exit code ' + code + (signal ? ' signal ' + signal : '')));
        emitPhotoError('capture', {
            exitCode: code,
            signal: signal || null,
            timedOut: !!timedOut,
            reason: reason
        });
        return;
    }

    socket.emit('sending-photo', {takeId:takeId});

    fs.readFile(getAbsoluteImagePath(), function(err, buffer){
        if (typeof buffer == 'undefined') {
            emitPhotoError('read', {reason: err ? err.message : 'output file missing'});
            return;
        }

        var totalDelay = Date.now() - lastReceiveTime;
        var imageDelay = Date.now() - photoStartTime;
        socket.emit('new-photo', {
            takeId:takeId,
            startTime:lastReceiveTime,
            time:Date.now(),
            photoStartTime:photoStartTime,
            totalDelay: totalDelay,
            imageDelay: imageDelay,
            fileName: fileName
        });
    });

    var fileName = os.hostname() + '.jpg';

    var form = new FormData();
    form.append('startTime', lastReceiveTime);
    form.append('cameraName', cameraName);
    form.append('fileName', fileName);
    form.append('image', fs.createReadStream(getAbsoluteImagePath()));

    form.submit(httpServer + '/new-image', function(err, res) {
        if (err) {
            emitPhotoError('upload', {reason: err.message || String(err)});
        } else {
            console.log("Image uploaded");
        }

        fs.unlink(getAbsoluteImagePath(), function () {
            // file deleted
        });

        if (res) res.resume();
    });
}




function takeImage(focusValue, command,customCommand) {  // Accept the command parameter
    var args = [
        '-q', 100,
        '-o', getAbsoluteImagePath(),
        //'--brightness', 0.0
    ];

    //if (focusValue) {
    //    args.push('--lens-position', focusValue);
    //}

    // Process the command to customize the arguments
    if (customCommand) {
        var customCommandArgs = customCommand.split(' ');
        args = args.concat(customCommandArgs);
    }

    var imageProcess = spawn('libcamera-still', args);
    var stderrBuf = '';
    imageProcess.stderr.on('data', function (data) { stderrBuf += data.toString(); });
    imageProcess.on('error', function (err) {
        emitPhotoError('spawn', {reason: err.message || String(err)});
    });

    var timedOut = false;
    var killTimer = setTimeout(function () {
        timedOut = true;
        imageProcess.kill();
    }, 10000);

    imageProcess.on('exit', function (code, signal) {
        clearTimeout(killTimer);
        sendImage(code, signal, stderrBuf, timedOut);
    });
}



function updateSoftware() {
    process.env.HOME = require('os').homedir();
    var safeDir = "'" + __dirname.replace(/'/g, "'\\''") + "'";
    var cmd = 'cd ' + safeDir + ' && '
            + 'git -c safe.directory=' + safeDir + ' fetch --all --prune && '
            + 'git -c safe.directory=' + safeDir + ' reset --hard origin/master && '
            + '(npm install --no-audit --no-fund || true)';
    childProcess = exec(cmd, function (error, stdout, stderr) {
        console.log('update stdout:\n' + stdout);
        console.log('update stderr:\n' + stderr);
        var ok = !error;
        if (error) console.log('update exec error: ' + error);
        socket.emit('update-result', {
            cameraName: cameraName,
            hostName: hostName,
            ok: ok,
            stderrTail: (stderr || '').split('\n').filter(Boolean).slice(-5).join('\n')
        });
        console.log('Update ' + (ok ? 'complete' : 'failed') + ', exiting for supervisor restart');
        setTimeout(function () { process.exit(ok ? 0 : 1); }, 500);
    });
}

function guid() {
    function s4() {
        return Math.floor((1 + Math.random()) * 0x10000)
            .toString(16)
            .substring(1);
    }
    return s4() + s4() + '-' + s4() + '-' + s4() + '-' +
        s4() + '-' + s4() + s4() + s4();
}

boot();
