var version = '1.28';

var args = process.argv.slice(2);

var httpServer = 'http://192.168.0.16:8080';
var socketServer = 'http://192.168.0.16:3000/';
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

function boot() {
    console.log("Starting");
    
    hostName = os.hostname();
    
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
    });
}

socket.on('connect', function(){
    console.log('A socket connection was made');
    
    socket.emit('camera-online', {name: cameraName, ipAddress: ipAddress, version: version});
    
    // Setup a regular heartbeat interval
    var heartbeatIntervalID = setInterval(heartbeat, 1000);
});

socket.on('take-photo', async function(data){
    console.log("Taking a photo");
    
    const focusValue = await loadFocusValue();
    photoStartTime  = Date.now();
    lastReceiveTime = data.time;
    takeId          = data.takeId;
    
    takeImage(focusValue);
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

socket.on('preview', function(data){
    console.log("Starting preview...");

    if (previewProcess) {
        previewProcess.kill();
    }
    
    previewProcess = spawn('libcamera-vid', [
        '--width', '640',
        '--height', '480',
        '--framerate', '30',
        '--inline',
        '--codec', 'mjpeg',
        '--listen',
        '-o', 'tcp://0.0.0.0:8888' // Stream over TCP
    ]);

    previewProcess.stderr.on('data', (data) => {
        console.error(`stderr: ${data}`);
    });

    previewProcess.on('close', (code) => {
        console.log(`child process exited with code ${code}`);
    });

    socket.emit('preview-url', 'tcp://' + ipAddress + ':8888');
});

socket.on('stop-preview', function(){
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
    socket.emit('camera-online', {name: cameraName, ipAddress: ipAddress, hostName: hostName, version: version, updateInProgress: updateInProgress});
}

function getAbsoluteImagePath() {
    return path.join(__dirname, imagePath, imageName);
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

function sendImage(code) {
    if (code !== 0) {
        socket.emit('photo-error', {takeId:takeId});
        return;
    }
    
    socket.emit('sending-photo', {takeId:takeId});
    
    fs.readFile(getAbsoluteImagePath(), function(err, buffer){
        if (typeof buffer == 'undefined') {
            socket.emit('photo-error', {takeId:takeId});
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
    
    var fileName = guid() + '.jpg';
    
    var form = new FormData();
    form.append('takeId', takeId);
    form.append('startTime', lastReceiveTime);
    form.append('cameraName', cameraName);
    form.append('fileName', fileName);
    form.append('image', fs.createReadStream(getAbsoluteImagePath()));

    form.submit(httpServer + '/new-image', function(err, res) {
        if (err) {
            socket.emit('photo-error', {takeId:takeId});
        } else {
            console.log("Image uploaded");
        }
        
        fs.unlink(getAbsoluteImagePath(), function () {
            // file deleted
        });
        
        res.resume();
    });
}

function takeImage(focusValue) {
    var args = [
        '-q', 90,     
        '-o', getAbsoluteImagePath()   
    ];

    if (focusValue) {
        args.push('--lens-position', focusValue);
    }
    var imageProcess = spawn('libcamera-still', args);
    setTimeout(function(){ imageProcess.kill()}, 10000);
    
    imageProcess.on('exit', sendImage);
}

function updateSoftware() {
    childProcess = exec('cd ' + __dirname + '; git pull', function (error, stdout, stderr) {
        console.log('stdout: ' + stdout);
        console.log('stderr: ' + stderr);
        if (error !== null) {
            console.log('exec error: ' + error);
        }
        process.exit();
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
