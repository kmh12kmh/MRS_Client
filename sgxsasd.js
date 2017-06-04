var cluster = require('cluster');
var events = require('events');
var util = require('util');
var numCPUs = require('os').cpus().length;
var https = require('https');
var fs = require("fs");
var async = require('async');
var request = require('request-promise');
var RaspiCam = require("raspicam");
var axios = require('axios');
var path = require('path');
var exec = require('child_process').exec;
var id = require('machine-uuid');
var mic = require('mic');
var getDuration = require('get-video-duration');
var FormData = require('form-data');
var concat = require('concat-stream');
var say = require('say');


/*
	1. 앱 시작
	2. faceCam on
	3. streaming file 생성
	4. face api detect 호출
	5. response(face id)로 face api identity 호출
	6. response(confidence) 0.8 이상이면 얼굴 일치 true
	7. 얼굴 일치 true면 videoCam(녹화) start && TTS(Text To Speech) "얼굴 확인되었습니다. 녹화를 시작합니다"
	8. cluster 노예 1명으로 바코드 인식
	9. 바코드 우리 서버로 api 호출
	10. 기존 환자에게 처방된 약 or 주사인지 비교. true면 db에 기록
	11. 30분(시연 용은 30초) 후에 videoCam(녹화) 종료
	12. 서버로 video file 전송
	13. faceCam 재실행
*/

cluster.schedulingPolicy = cluster.SCHED_NONE;
cluster.schedulingPolicy = cluster.SCHED_RR;

var recogDoctorName = 'lee';
var rawConvert_command = "sudo MP4Box -add ./video/temp_video.h264 -fps 30 ./video/convert_video.mp4 && sudo ffmpeg -i ./video/temp_audio.raw -f mp2 ./video/audio.mp2";
var startflag = 0;
var recogflag = 0;
var uuid;
var myKey = '키'

id(function(getuuid) {
  uuid = getuuid
});

// 클래스 선언

var MedicalRecordSystem = function() {
  if (!(this instanceof MedicalRecordSystem)) {
    return new MedicalRecordSystem();
  }

  // 초기화 코드

  this.fileIndex = 1;
  this.recognitionCam = new RaspiCam({
    mode: "timelapse",
    output: "./image/image_%d.jpg", // image_1.jpg, image_2.jpg,...
    encoding: "jpg",
    timelapse: 2000, // take a picture every 2 seconds
    timeout: 999999999, // take a total of 4 pictures over 12 seconds
    nopreview: true
  });

  this.recognitionCam.on('start', function() {
    if (startflag == 0) {
      say.speak('Welcome to Medical Recording System, Project start!');
      startflag++;
    }
  });

  this.videoCam = new RaspiCam({
    mode: "video",
    output: "./video/temp_video.h264",
    framerate: 30,
    width: 640,
    height: 480,
    timeout: 20000
  });

  this.micInstance = new mic({
    'rate': '16000',
         'channels': '1',
         'debug': false,
         'exitOnSilence': 6
  });

  this.micInputStream = this.micInstance.getAudioStream();
  this.outputFileStream = fs.createWriteStream('./video/temp_audio.raw');
  this.micInputStream.pipe(this.outputFileStream);
  this.date = 0;
  this.year = 0;
  this.month = 0;
  this.day = 0;
  this.hour = 0;
  this.minut = 0;
  this.second = 0;
  this.video_duration = 0;
  this.audio_duration = 0;
  this.merge_duration = 0;
  this.audio_getduration = 0;
  this.video_getduration = 0;
  this.rawConvert = null;
  this.audioSyncConvert = null;
  this.finalMerge = null;
}

MedicalRecordSystem.prototype.start = function() {
  var self = this;
  // 마스터이면
  self.videoCam.on('exit', function(err, timestamp) {
    say.speak('Video recording is completed, Face recognition starts!');
    console.log('videoCam stopped', timestamp);
    self.micInstance.stop();
    self.micInputStream.on('stopComplete', function() {
      console.log('stopped');
      self.outputFileStream.close();
    });
  });

  if (cluster.isMaster) {
    // CPU 개수 만큼 노예 생성
    for (var i = 0; i < numCPUs; i++) {
      cluster.fork();
    }
    // 부모로부터 메시지 받음. apiRequest
    for (const id in cluster.workers) {
      cluster.workers[id].on('message', function(workerResult) {
        var apiResult = workerResult.result;
        var highRecogFileName = workerResult.filename;
        console.log('filename : ', highRecogFileName);
        for (var i = 0; i < apiResult.length; i++) {
          for (var j = 0; j < apiResult[i].candidates.length; j++) {
            console.log('의사 얼굴 인식 : ', apiResult[i].candidates[j].confidence);
            if (apiResult[i].candidates[j].confidence > 0.75) {
              self.date = new Date();
              self.year = self.date.getFullYear();
              self.month = self.date.getMonth() + 1;
              self.day = self.date.getDate();
              self.hour = self.date.getHours();
              self.minute = self.date.getMinutes();
              self.second = self.date.getSeconds();
              self.stopRecognitionCam();
              self.startVideoCam();
              recogDoctorName = apiResult[i].candidates[j].personId;
              console.log('apiresult.length : ', apiResult.length);
              console.log('aprresult.candidates.length : ', apiResult[i].candidates.length);
              if (apiResult.length == 1 && apiResult[i].candidates.length == 1) {
                addPersonFace(apiResult[i].candidates[j].personId, highRecogFileName);
              }
              break;
            }
          }
        }
      });
    }
    cluster.on('disconnected', function(worker) {
      console.log('worker ' + worker.pid + ' died');
    });

    self.recognitionCam.start();

    self.recognitionCam.on('read', function(err, timestamp, filename) {
      if (filename.indexOf("~") != -1) return;
      else {
        cluster.workers[self.fileIndex].send(filename);
        self.fileIndex++;
        if (self.fileIndex == 5) {
          self.fileIndex = 1;
        }
      }
    });

    self.recognitionCam.on('start', function(err, timestamp) {

      self.micInstance = new mic({
        'rate': '16000',
             'channels': '1',
             'debug': false,
             'exitOnSilence': 6
      });

      self.micInputStream = self.micInstance.getAudioStream();
      self.outputFileStream = fs.createWriteStream('./video/temp_audio.raw');
      self.micInputStream.pipe(self.outputFileStream);

      self.videoCam = new RaspiCam({
        mode: "video",
        output: "./video/temp_video.h264",
        framerate: 30,
        width: 640,
        height: 480,
        timeout: 20000
      });

      self.videoCam.on('exit', function(err, timestamp) {
        recogflag = 0;
        console.log('videoCam stopped', timestamp);
        self.micInstance.stop();
        self.micInputStream.on('stopComplete', function() {
          console.log('stopped');
          self.outputFileStream.close();
        });
      });

      self.outputFileStream.on('finish', function() {
        self.rawConvert = exec(rawConvert_command, function(error, stdout, stderr) {
          if (error) {
            console.log(error);
            return;
          }
        });

        self.rawConvert.on('exit', function(code) {
          getDuration('./video/audio.mp2').then(function(audioDuration) {
            self.audio_duration = audioDuration;
            console.log("audio duration : " + self.audio_duration);
            getDuration('./video/convert_video.mp4').then(function(videoDuration) {
              self.video_duration = videoDuration;
              console.log("video duration : " + self.video_duration);

              // then 한번 더 쓸지 판단
            }).then(function() {
              self.merge_duration = self.audio_duration / self.video_duration;
              console.log("merge_duration : " + self.merge_duration);
              var audioSyncConvert_command = "sudo ffmpeg -i ./video/audio.mp2 -filter:a \"atempo=" + self.merge_duration + "\" -vn ./video/convert_audio.mp2";

              self.audioSyncConvert = exec(audioSyncConvert_command, (error, stdout, stderr) => {
                if (error) {
                  console.log('sync error: ' + error);
                  return;
                }
              });
              self.audioSyncConvert.on('exit', function(code) {
                var merge_command = "sudo MP4Box -new -add ./video/convert_video.mp4 -add ./video/convert_audio.mp2 ./video/" + self.year + "_" + self.month + "_" + self.day + "_" + self.hour + "_" + self.minute + "_" + self.second + ".mp4";
                self.finalMerge = exec(merge_command, (error, stdout, stderr) => {
                  if (error) {
                    console.log('merge error: ' + error);
                    return;
                  }
                });

                self.finalMerge.on('exit', function(code) {
                  var transdata = "./video/" + self.year + "_" + self.month + "_" + self.day + "_" + self.hour + "_" + self.minute + "_" + self.second + ".mp4";
                  var transformat = fs.createReadStream(path.join(__dirname, transdata));
                  var myForm = new FormData(); 
                  var CRLF = '\r\n';
                  var options = { 
                    header: CRLF + '--' + myForm.getBoundary() + CRLF + 'Authorization: test-uuid' + CRLF + CRLF,
                  };

                  myForm.append('boxcam', transformat);
                  myForm.pipe(concat({
                    encoding: 'buffer'
                  }, function(data) {
                    axios.post('http://13.124.126.30:3000/api/v1/patient/upload/' + recogDoctorName, data, {
                      headers: {
                        'Content-Type': 'multipart/form-data; boundary=' + myForm.getBoundary(),
                        'Authorization': uuid,
                      }
                    }).then(function(result) {
                      if (result) {
                        exec('sudo rm ./video/*.mp2 ./video/convert_video* ./video/temp_*', function(error, stdout, stderr) {
                          if (error) {
                            console.error(error);
                          }
                          self.micInputStream.on('processExitComplete', function() {
                            console.log("Got SIGNAL processExitComplete");
                          });
                          self.recognitionCam.start();
                        });
                      }
                    }).catch(error => {
                      console.error(error);
                    });
                  }));
                });
              });
            });
          });
        });
      });
    });

    self.recognitionCam.on("exit", function(timestamp) {
      if (recogflag == 0) {
        say.speak('Doctor\'s Face was recognized, Video recording starts.');
        recogflag++;
      }
    });
  }

  if (cluster.isWorker) {
    process.on('message', function(filename) {
      async.waterfall([
        function(callback) {
          console.log('face dedtect start');
          fs.readFile("image/" + filename, function(err, data) {
            if (err) {
              console.error("read jpg fail ", err);
            }
            var post_options = {
              host: 'southeastasia.api.cognitive.microsoft.com',
              method: 'POST',
              data: data,
              path: '/face/v1.0/detect?returnFaceId=true',
              headers: {
                'Content-Type': 'application/octet-stream',
                'Ocp-Apim-Subscription-Key': myKey
              }
            };

            var post_req = https.request(post_options, function(response) {
              response.on('data', function(rdata) {
                var jsonparsed = JSON.parse(rdata);
                callback(null, jsonparsed);
              });
            });
            post_req.write(data, function() {
              post_req.end();
            });
          });
        },
        function(jsonparsed, callback) {
          console.log('identify start');
          var reqFaceIds = [];
          for (var i = 0; i < jsonparsed.length; i++) {
            reqFaceIds.push(jsonparsed[i].faceId)
          }

          var reqOptions = {
            method: 'POST',
            json: true,
            uri: 'https://southeastasia.api.cognitive.microsoft.com/face/v1.0/identify',
            headers: {
              'content-type': 'application/json',
              'Ocp-Apim-Subscription-Key': myKey
            },
            body: {
              "personGroupId": 'doctor',
              "faceIds": reqFaceIds,
              "maxNumOfCandidatesReturned": 1,
              "confidenceThreshold": 0.5
            }
          };
          request(reqOptions).then(function(result) {
            callback(null, result);
          }).catch(function(err) {});
        }
      ], function(err, result) {
        if (err) {
          console.error(err);
        }
        if (result) {
          process.send({
            'result': result,
            'filename': filename
          });
        }
      });
    });
  }

  this.outputFileStream.on('finish', function() {
    self.rawConvert = exec(rawConvert_command, function(error, stdout, stderr) {
      if (error) {
        console.log(error);
        return;
      }
    });

    self.rawConvert.on('exit', function(code) {
      getDuration('./video/audio.mp2').then(function(audioDuration) {
        self.audio_duration = audioDuration;
        console.log("audio duration : " + self.audio_duration);
        getDuration('./video/convert_video.mp4').then(function(videoDuration) {
          self.video_duration = videoDuration;
          console.log("video duration : " + self.video_duration);

          // then 한번 더 쓸지 판단
        }).then(function() {
          self.merge_duration = self.audio_duration / self.video_duration;
          console.log("merge_duration : " + self.merge_duration);
          var audioSyncConvert_command = "sudo ffmpeg -i ./video/audio.mp2 -filter:a \"atempo=" + self.merge_duration + "\" -vn ./video/convert_audio.mp2";

          self.audioSyncConvert = exec(audioSyncConvert_command, (error, stdout, stderr) => {
            if (error) {
              console.log('sync error: ' + error);
              return;
            }
          });
          self.audioSyncConvert.on('exit', function(code) {
            var merge_command = "sudo MP4Box -new -add ./video/convert_video.mp4 -add ./video/convert_audio.mp2 ./video/" + self.year + "_" + self.month + "_" + self.day + "_" + self.hour + "_" + self.minute + "_" + self.second + ".mp4";
            self.finalMerge = exec(merge_command, (error, stdout, stderr) => {
              if (error) {
                console.log('merge error: ' + error);
                return;
              }
            });

            self.finalMerge.on('exit', function(code) {
              var transdata = "./video/" + self.year + "_" + self.month + "_" + self.day + "_" + self.hour + "_" + self.minute + "_" + self.second + ".mp4";
              var transformat = fs.createReadStream(path.join(__dirname, transdata));
              var myForm = new FormData(); 
              var CRLF = '\r\n';
              var options = { 
                header: CRLF + '--' + myForm.getBoundary() + CRLF + 'Authorization: test-uuid' + CRLF + CRLF,
              };

              myForm.append('boxcam', transformat);
              myForm.pipe(concat({
                encoding: 'buffer'
              }, function(data) {
                axios.post('http://13.124.126.30:3000/api/v1/patient/upload/' + recogDoctorName, data, {
                  headers: {
                    'Content-Type': 'multipart/form-data; boundary=' + myForm.getBoundary(),
                    'Authorization': uuid,
                  }
                }).then(function(result) {
                  if (result) {
                    exec('sudo rm ./video/*.mp2 ./video/convert_video* ./video/temp_*', function(error, stdout, stderr) {
                      if (error) {
                        console.error(error);
                      }
                      self.micInputStream.on('processExitComplete', function() {
                        console.log("Got SIGNAL processExitComplete");
                      });
                      self.recognitionCam.start();
                    });
                  }
                }).catch(error => {
                  console.error(error);
                });
              }));
            });
          });
        });
      });
    });
  });
}


function addPersonFace(personId, filename) {
  async.waterfall([
    function(callback) {
      fs.readFile("image/" + filename, function(err, data) {
        if (err) {
          console.error("read jpg fail ", err);
        }
        var post_options = {
          host: 'southeastasia.api.cognitive.microsoft.com',
          method: 'POST',
          data: data,
          path: '/face/v1.0/persongroups/doctor/persons/' + personId + '/persistedFaces?',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Ocp-Apim-Subscription-Key': myKey
          }
        };

        var post_req = https.request(post_options, function(response) {
          response.on('data', function(rdata) {
            var jsonparsed = JSON.parse(rdata);
          });
        });
        post_req.write(data, function() {
          post_req.end();
        });
      });
    },
    function(callback) {
      var reqOptions = {
        method: 'POST',
        json: true,
        uri: 'https://southeastasia.api.cognitive.microsoft.com/face/v1.0/persongroups/doctor/train',
        headers: {
          'content-type': 'application/json',
          'Ocp-Apim-Subscription-Key': myKey
        },
        body: {}
      };
      request(reqOptions).then(function(result) {
        console.log('trainning succes');
      }).catch(function(err) {});
    }
  ], function(err, result) {
    if (err) {
      console.error(err);
    }
  });
}

//Promise stopRecognitionCam
MedicalRecordSystem.prototype.stopRecognitionCam = function() {
  this.recognitionCam.stop();
  this.startMicInstance();
  return this;
}

MedicalRecordSystem.prototype.startVideoCam = function() {
  this.videoCam.start();
  this.videoCam.on('start', function(err, timestamp) {
    console.log('videoCam started: ', timestamp);
  });
  return this;
}

MedicalRecordSystem.prototype.startMicInstance = function() {
  this.micInstance.start();
  return this;
}

var mrs = new MedicalRecordSystem();

mrs.start();

process.stdin.setEncoding('utf8');

process.stdin.on('readable', function() {
  var chunk = process.stdin.read();
  if (uuid) {
    axios({
      method: 'POST',
      url: 'http://13.124.126.30:3000/api/v1/patient/addMedicalTime',
      headers: {
        'Authorization': uuid
      },
      data: {
        barcode: chunk
      }
    }).then(function(res) {
      console.log(res.data.result);
      if (!res.data.result)
        say.speak('It\'s not for this patient.');
    }).catch(function(err) {
      say.speak('barcode error');
    })
  }
});
