/*
 * Copyright © 2016-2017 The Thingsboard Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import 'angular-websocket';
import thingsboardTypes from '../common/types.constant';

export default angular.module('thingsboard.api.telemetryWebsocket', [thingsboardTypes])
    .factory('telemetryWebsocketService', TelemetryWebsocketService)
    .name;

const RECONNECT_INTERVAL = 2000;
const WS_IDLE_TIMEOUT = 90000;

/*@ngInject*/
function TelemetryWebsocketService($rootScope, $websocket, $timeout, $window, types, userService) {

    var isOpening = false,
        isOpened = false,
        isActive = false,
        isReconnect = false,
        reconnectSubscribers = [],
        lastCmdId = 0,
        subscribers = {},
        subscribersCount = 0,
        cmdsWrapper = {
            tsSubCmds: [],
            historyCmds: [],
            attrSubCmds: []
        },
        telemetryUri,
        dataStream,
        location = $window.location,
        socketCloseTimer,
        reconnectTimer;

    var port = location.port;
    if (location.protocol === "https:") {
        if (!port) {
            port = "443";
        }
        telemetryUri = "wss:";
    } else {
        if (!port) {
            port = "80";
        }
        telemetryUri = "ws:";
    }
    telemetryUri += "//" + location.hostname + ":" + port;
    telemetryUri += "/api/ws/plugins/telemetry";

    var service = {
        subscribe: subscribe,
        unsubscribe: unsubscribe
    }

    $rootScope.telemetryWsLogoutHandle = $rootScope.$on('unauthenticated', function (event, doLogout) {
        if (doLogout) {
            reset(true);
        }
    });

    return service;

    function publishCommands () {
        if (isOpened && (cmdsWrapper.tsSubCmds.length > 0 ||
            cmdsWrapper.historyCmds.length > 0 ||
            cmdsWrapper.attrSubCmds.length > 0)) {
            dataStream.send(angular.copy(cmdsWrapper)).then(function () {
                checkToClose();
            });
            cmdsWrapper.tsSubCmds = [];
            cmdsWrapper.historyCmds = [];
            cmdsWrapper.attrSubCmds = [];
        }
        tryOpenSocket();
    }

    function onError (/*message*/) {
        isOpening = false;
    }

    function onOpen () {
        isOpening = false;
        isOpened = true;
        if (reconnectTimer) {
            $timeout.cancel(reconnectTimer);
            reconnectTimer = null;
        }
        if (isReconnect) {
            isReconnect = false;
            for (var r=0; r<reconnectSubscribers.length;r++) {
                var reconnectSubscriber = reconnectSubscribers[r];
                if (reconnectSubscriber.onReconnected) {
                    reconnectSubscriber.onReconnected();
                }
                subscribe(reconnectSubscriber);
            }
            reconnectSubscribers = [];
        } else {
            publishCommands();
        }
    }

    function onClose () {
        isOpening = false;
        isOpened = false;
        if (isActive) {
            if (!isReconnect) {
                reconnectSubscribers = [];
                for (var id in subscribers) {
                    reconnectSubscribers.push(subscribers[id]);
                }
                reset(false);
                isReconnect = true;
            }
            if (reconnectTimer) {
                $timeout.cancel(reconnectTimer);
            }
            reconnectTimer = $timeout(tryOpenSocket, RECONNECT_INTERVAL, false);
        }
    }

    function onMessage (message) {
        if (message.data) {
            var data = angular.fromJson(message.data);
            if (data.subscriptionId) {
                var subscriber = subscribers[data.subscriptionId];
                if (subscriber && data) {
                    var keys = fetchKeys(subscriber);
                    if (!data.data) {
                        data.data = {};
                    }
                    for (var k = 0; k < keys.length; k++) {
                        var key = keys[k];
                        if (!data.data[key]) {
                            data.data[key] = [];
                        }
                    }
                    subscriber.onData(data);
                }
            }
        }
        checkToClose();
    }

    function fetchKeys(subscriber) {
        var command;
        if (angular.isDefined(subscriber.subscriptionCommand)) {
            command = subscriber.subscriptionCommand;
        } else {
            command = subscriber.historyCommand;
        }
        if (command && command.keys && command.keys.length > 0) {
            return command.keys.split(",");
        } else {
            return [];
        }
    }

    function nextCmdId () {
        lastCmdId++;
        return lastCmdId;
    }

    function subscribe (subscriber) {
        isActive = true;
        var cmdId = nextCmdId();
        subscribers[cmdId] = subscriber;
        subscribersCount++;
        if (angular.isDefined(subscriber.subscriptionCommand)) {
            subscriber.subscriptionCommand.cmdId = cmdId;
            if (subscriber.type === types.dataKeyType.timeseries) {
                cmdsWrapper.tsSubCmds.push(subscriber.subscriptionCommand);
            } else if (subscriber.type === types.dataKeyType.attribute) {
                cmdsWrapper.attrSubCmds.push(subscriber.subscriptionCommand);
            }
        } else if (angular.isDefined(subscriber.historyCommand)) {
            subscriber.historyCommand.cmdId = cmdId;
            cmdsWrapper.historyCmds.push(subscriber.historyCommand);
        }
        publishCommands();
    }

    function unsubscribe (subscriber) {
        if (isActive) {
            var cmdId = null;
            if (subscriber.subscriptionCommand) {
                subscriber.subscriptionCommand.unsubscribe = true;
                if (subscriber.type === types.dataKeyType.timeseries) {
                    cmdsWrapper.tsSubCmds.push(subscriber.subscriptionCommand);
                } else if (subscriber.type === types.dataKeyType.attribute) {
                    cmdsWrapper.attrSubCmds.push(subscriber.subscriptionCommand);
                }
                cmdId = subscriber.subscriptionCommand.cmdId;
            } else if (subscriber.historyCommand) {
                cmdId = subscriber.historyCommand.cmdId;
            }
            if (cmdId && subscribers[cmdId]) {
                delete subscribers[cmdId];
                subscribersCount--;
            }
            publishCommands();
        }
    }

    function checkToClose () {
        if (subscribersCount === 0 && isOpened) {
            if (!socketCloseTimer) {
                socketCloseTimer = $timeout(closeSocket, WS_IDLE_TIMEOUT, false);
            }
        }
    }

    function tryOpenSocket () {
        if (isActive) {
            if (!isOpened && !isOpening) {
                isOpening = true;
                if (userService.isJwtTokenValid()) {
                    openSocket(userService.getJwtToken());
                } else {
                    userService.refreshJwtToken().then(function success() {
                        openSocket(userService.getJwtToken());
                    }, function fail() {
                        isOpening = false;
                        $rootScope.$broadcast('unauthenticated');
                    });
                }
            }
            if (socketCloseTimer) {
                $timeout.cancel(socketCloseTimer);
                socketCloseTimer = null;
            }
        }
    }

    function openSocket(token) {
        dataStream = $websocket(telemetryUri + '?token=' + token);
        dataStream.onError(onError);
        dataStream.onOpen(onOpen);
        dataStream.onClose(onClose);
        dataStream.onMessage(onMessage, {autoApply: false});
    }

    function closeSocket() {
        isActive = false;
        if (isOpened) {
            dataStream.close();
        }
    }

    function reset(close) {
        if (socketCloseTimer) {
            $timeout.cancel(socketCloseTimer);
            socketCloseTimer = null;
        }
        lastCmdId = 0;
        subscribers = {};
        subscribersCount = 0;
        cmdsWrapper.tsSubCmds = [];
        cmdsWrapper.historyCmds = [];
        cmdsWrapper.attrSubCmds = [];
        if (close) {
            closeSocket();
        }
    }
}
