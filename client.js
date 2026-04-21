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
var currentProject = null;

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
    console.log("Taking a photo, project=", data.project);
    const focusValue = null;
    photoStartTime  = Date.now();
    lastReceiveTime = data.time;
    takeId          = data.takeId;
    currentProject  = data.project || null;

    let customCommand = '';
    if (data.customCommands && data.customCommands[socket.id]) {
        customCommand = data.customCommands[socket.id];
    }
    console.log("Taking a photo with command: ", customCommand);

    takeImage(focusValue, data.command, customCommand);
});

socket.on('take-video', (data) => {
    const msg = data || {};
    console.log('Video recording requested, payload:', msg);
    currentProject = msg.project || null;

    const opts = {
        cameraId: msg.takeId,
        duration: msg.duration || 10000,
        framerate: msg.framerate || 24,
        customCommand: (msg.customCommands && msg.customCommands[socket.id]) || null,
        takeId: msg.takeId,
        startTime: msg.time || Date.now()
    };

    const delay = Math.max(0, (msg.startAt || 0) - Date.now());
    if (delay > 0) {
        console.log('[sync] scheduled record start in ' + delay + 'ms');
        setTimeout(function () { recordVideo(opts); }, delay);
    } else {
        if (msg.startAt) {
            console.warn('[sync] late arrival, starting immediately. clock skew or network lag >' + Math.abs((msg.startAt || 0) - Date.now()) + 'ms');
        }
        recordVideo(opts);
    }
});


socket.on('update-software', function(data){
    console.log("Updating software");

    updateInProgress = true;

    updateSoftware();
});

socket.on('reboot', function (data) {
    console.log("Reboot requested");
    // Short delay so the socket can flush the log and any heartbeat.
    setTimeout(function () {
        exec('/sbin/reboot || sudo -n /sbin/reboot', function (err, stdout, stderr) {
            if (err) {
                console.error('reboot failed:', err.message);
                console.error('stderr:', stderr);
            }
        });
    }, 300);
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

function cleanupPreviewProcess() {
    if (previewProcess && previewProcess.exitCode === null) {
        try { previewProcess.kill('SIGTERM'); } catch (e) {}
    }
}

// Propagate shutdown to the python preview child so supervisor restarts
// (or any SIGTERM) don't leave it orphaned holding the camera.
['SIGTERM', 'SIGINT', 'SIGHUP'].forEach(function (sig) {
    process.on(sig, function () {
        console.log('Got ' + sig + ', cleaning up preview child');
        cleanupPreviewProcess();
        setTimeout(function () { process.exit(0); }, 300);
    });
});
process.on('exit', cleanupPreviewProcess);

function spawnPreview(clientSocketId, previewOpts) {
    console.log("Starting preview for clientSocketId=", clientSocketId, "opts=", previewOpts);
    previewOpts = previewOpts || {};

    var args = ['camera_stream.py'];
    if (previewOpts.width)   args.push('--width',   String(previewOpts.width));
    if (previewOpts.height)  args.push('--height',  String(previewOpts.height));
    if (previewOpts.quality) args.push('--quality', String(previewOpts.quality));

    previewProcess = spawn('python3', args, { cwd: __dirname });
    var urlEmitted = false;

    function emitPreviewUrl() {
        if (urlEmitted) return;
        urlEmitted = true;
        socket.emit('preview-url', {
            url: 'http://' + ipAddress + ':8888/',
            clientSocketId: clientSocketId
        });
    }

    previewProcess.stdout.on('data', function (chunk) {
        var text = chunk.toString();
        console.log('[preview stdout]', text.trim());
        if (text.indexOf('MJPEG preview server') !== -1) {
            emitPreviewUrl();
        }
    });

    previewProcess.stderr.on('data', function (chunk) {
        console.error('[preview stderr]', chunk.toString().trim());
    });

    previewProcess.on('error', function (err) {
        console.error('[preview] spawn error:', err.message);
    });

    previewProcess.on('close', function (code) {
        console.log('preview process exited with code', code);
    });

    // Fallback: if stdout readiness line is missed, still emit URL after 2s
    // so the browser <img> can at least attempt to connect.
    setTimeout(emitPreviewUrl, 2000);
}

socket.on('preview', function(data) {
    var clientSocketId = data && data.clientSocketId;
    var previewOpts = {
        width:   (data && data.width)   || 1280,
        height:  (data && data.height)  || 720,
        quality: (data && data.quality) || 85
    };

    if (previewProcess && previewProcess.exitCode === null) {
        // Wait for old process to actually release the camera before spawning a new one.
        var oldProc = previewProcess;
        oldProc.once('close', function () {
            setTimeout(function () { spawnPreview(clientSocketId, previewOpts); }, 250);
        });
        try { oldProc.kill('SIGTERM'); } catch (e) {}
        // Hard fallback: if it doesn't die in 2s, SIGKILL it
        setTimeout(function () {
            if (oldProc.exitCode === null) {
                try { oldProc.kill('SIGKILL'); } catch (e) {}
            }
        }, 2000);
        return;
    }

    spawnPreview(clientSocketId, previewOpts);
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
    const { duration, framerate, customCommand, takeId, startTime } = opts || {};
    // libav codec → libcamera-apps uses ffmpeg as muxer, producing a real MP4
    // (default h264 codec writes only a raw .h264 elementary stream which
    // browsers / Finder / QuickTime can't play even with .mp4 extension).
    // Container is inferred from the output filename extension.
    let args = [
        '--codec', 'libav',
        '--width', 1920,
        '--height', 1080,
        '--camera', 0,
        '-b', 20000000,
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
        sendVideo(getAbsoluteVideoPath(), takeId, startTime);
        recordingStatus = 'idle';
    });
}


function sendVideo(videoPath, takeId, startTime) {
    console.log('Sending video:', videoPath, 'takeId=', takeId, 'startTime=', startTime);
    if (!fs.existsSync(videoPath)) {
        socket.emit('recording-error', { takeId: takeId, reason: 'output file missing' });
        return;
    }

    socket.emit('sending-video', { takeId: takeId });

    var fileName = (hostName || cameraName || 'camera') + '.mp4';
    var form = new FormData();
    form.append('takeId', takeId || '');
    form.append('startTime', startTime || Date.now());
    form.append('cameraName', cameraName || hostName || '');
    form.append('hostName', hostName || '');
    form.append('project', currentProject || '');
    form.append('fileName', fileName);
    form.append('video', fs.createReadStream(videoPath));

    form.submit(httpServer + '/new-video', function (err, res) {
        if (err) {
            console.error('Error uploading video:', err.message || err);
            socket.emit('recording-error', { takeId: takeId, reason: err.message || String(err) });
        } else {
            console.log('Video uploaded successfully');
        }

        fs.unlink(videoPath, function () {
            console.log('Temporary video file deleted:', videoPath);
        });

        if (res) res.resume();
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
    form.append('project', currentProject || '');
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
