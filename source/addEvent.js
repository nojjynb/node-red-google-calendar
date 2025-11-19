var axios = require('axios');
module.exports = function(RED) {
    "use strict";
    function addEventToCalendar(n) {
        RED.nodes.createNode(this,n);
        this.google = RED.nodes.getNode(n.google);
        if (!this.google || !this.google.credentials.accessToken) {
            this.warn(RED._("calendar.warn.no-credentials"));
            return;
        }
        var node = this;

        node.on('input', function(msg) {
            const payload = msg.payload || {};
            
            // --- 1. Get all event properties ---
            let event = {};
            event.calendarId = payload.calendarId || msg.calendarId || n.calendarId2 || "";
            event.summary = payload.summary || msg.summary || msg.title || msg.tittle || n.title || n.tittle;
            event.description = payload.description || msg.description || n.description;
            event.colorId = payload.colorId || msg.colorId || n.colorId;
            event.location = payload.location || msg.location || n.location;
            event.iCalUID = payload.iCalUID || msg.iCalUID || n.iCalUID;
            event.conference = payload.conference || msg.conference || n.conference;
            
            // --- 2. Handle Attendees ---
            let arrAttend = payload.attendees || payload.arrAttend || msg.arrAttend || n.arrAttend;
            if (!arrAttend || arrAttend.length === 0) {
                arrAttend = [];
                if (n.attend > 0) {
                    for (let index = 1; index < parseInt(n.attend) + 1; index++) {
                        if(n["email" + index] || n["name" + index]) {
                            if (validateEmail(n["email" + index])) {
                                arrAttend.push({
                                    email: n["email" + index] || '',
                                    displayName: n["name" + index] || ''
                                });
                            }
                        }
                    }
                }
            }

            // --- 3. Handle Dates ---
            let startInput = payload.start || msg.start;
            let endInput = payload.end || msg.end;
            let googleStart, googleEnd;

            if (typeof startInput === 'object' && startInput !== null && startInput.dateTime) {
                googleStart = startInput;
            } else {
                let timezone = payload.timezone || msg.timezone || n.timezone || "";
                let timeStartStr = startInput || (n.time ? n.time.split(" - ")[0] : new Date().toISOString());
                googleStart = { dateTime: new Date(timeStartStr + timezone).toISOString() };
            }

            if (typeof endInput === 'object' && endInput !== null && endInput.dateTime) {
                googleEnd = endInput;
            } else {
                let timezone = payload.timezone || msg.timezone || n.timezone || "";
                let timeEndStr = endInput || (n.time ? n.time.split(" - ")[1] : new Date().toISOString());
                googleEnd = { dateTime: new Date(timeEndStr + timezone).toISOString() };
            }

            // --- 4. Build the final Google API object ---
            const conferenceData = { createRequest: {requestId: requestIdGenerator()} };
            var api = 'https://www.googleapis.com/calendar/v3/calendars/';
            var newObj = {
                summary: event.summary,
                description: event.description,
                location: event.location,
                start: googleStart,
                end: googleEnd,
                attendees: arrAttend
            };

            if (event.colorId) newObj.colorId = event.colorId;
            if (event.conference) newObj.conferenceData = conferenceData;
            
            // *** CRITICAL: 'import' REQUIRES the iCalUID ***
            if (event.iCalUID) {
                newObj.iCalUID = event.iCalUID;
            } else {
                node.warn("Event is missing iCalUID. Skipping.");
                return; // 'import' will fail without this
            }
            
            if (!event.calendarId) {
                node.warn("No Calendar ID specified in msg or node config.");
                return;
            }

            // *** FIX: Change the endpoint from /events to /events/import ***
            var linkUrl = api + encodeURIComponent(event.calendarId) + '/events/import?conferenceDataVersion=1';
            var opts = {
                method: "POST",
                url: linkUrl,
                headers: { "Content-Type": "application/json" },
                data: newObj
            };

            node.log("Sending to Google (IMPORT): " + JSON.stringify(newObj, null, 2));

            // --- 5. Make the Request (No 409 logic needed) ---
            node.google.request(opts, function(err, responseData) {
                if (err) {
                    // All errors are now real errors
                    let errorMsg = "Error importing event.";
                    let errorDetail = err;
                    let statusCode = "Unknown";

                    if (err.response && err.response.data && err.response.data.error) {
                        let googleError = err.response.data.error;
                        statusCode = googleError.code || "Unknown";
                        errorMsg = `Google API Error: ${googleError.message} (Code: ${statusCode})`;
                        errorDetail = googleError;
                    } else if (err.message) {
                        errorMsg = "Error importing event: " + err.message;
                    }
                    
                    node.error(errorMsg, { error: errorDetail, fullErrorObject: err, requestBody: newObj, originalMsg: msg });
                    msg.payload = errorMsg;
                    msg.error = errorDetail;
                    msg.requestBody = newObj;
                    
                    let statusText = `Failed (Code ${statusCode})`;
                    if (statusText.length > 30) statusText = "Failed (see debug)";
                    node.status({fill:"red",shape:"ring",text: statusText});
                    
                    node.send(msg);
                    return;
                }
                
                // --- Success Handling ---
                if (responseData.kind == "calendar#event") {
                    let successSummary = responseData.summary || 'event';
                    
                    // 'import' returns 'created' or 'updated'
                    let action = "Processed";
                    if (responseData.status === "confirmed") {
                        // This usually means it was an update, but 'created' is also possible
                        action = responseData.created ? "Imported" : "Updated";
                    }

                    msg.payload = `Successfully ${action.toLowerCase()}: '${successSummary}'`;
                    msg.meetLink = responseData.hangoutLink ? responseData.hangoutLink : null;
                    msg.eventLink = responseData.htmlLink ? responseData.htmlLink : null;
                    msg.eventId = responseData.id;
                    msg.success = true;
                    node.status({ fill: "green", shape: "ring", text: `${action}: ${successSummary}` });
                } else {
                    const errorMsg = "Failed to import event: Invalid response format from Google.";
                    node.error(errorMsg, { response: responseData, requestBody: newObj });
                    msg.payload = errorMsg;
                    msg.error = "Invalid response format";
                    msg.success = false;
                    node.status({ fill: "red", shape: "ring", text: "Failed: Invalid response" });
                }
                
                node.send(msg);
            });
        });
    }
    RED.nodes.registerType("addEventToCalendar", addEventToCalendar);

    // ... (Your other helper functions: validateEmail, requestIdGenerator, /cal) ...
    function validateEmail(email) {
        var re = /\S+@\S+\.\S+/;
        return re.test(email);
    }

    function requestIdGenerator(){
        return (Math.random() + 1).toString(36);
    }

    RED.httpAdmin.get('/cal', function(req, res) {
        var googleId = res.socket.parser.incoming._parsedUrl.path.split("id=")[1];
        RED.nodes.getNode(googleId).request('https://www.googleapis.com/calendar/v3/users/me/calendarList', function(err, data) {
            if(err) return;

            var primary = "";
            var arrCalendar = [];

            for (var i = 0; i < data.items.length; i++) {
                var cal = data.items[i];
                if (cal.primary) {
                    primary = cal.id;
                } else {
                    arrCalendar.push(cal.id)
                }
            }

            var arrData = [];
            arrData.push(primary);
            arrCalendar.sort();
            arrCalendar.forEach(function(element) {
                arrData.push(element)
            })
            res.json(arrData)
        })
    })
};
