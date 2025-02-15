// Copyright (c) IPython Development Team.
// Distributed under the terms of the Modified BSD License.

define([
    'base/js/namespace',
    'jquery',
    'base/js/utils',
    'services/kernels/js/comm',
    'widgets/js/init',
], function(IPython, $, utils, comm, widgetmanager) {
    "use strict";

    /**
     * A Kernel class to communicate with the Python kernel. This
     * should generally not be constructed directly, but be created
     * by.  the `Session` object. Once created, this object should be
     * used to communicate with the kernel.
     * 
     * @class Kernel
     * @param {string} kernel_service_url - the URL to access the kernel REST api
     * @param {string} ws_url - the websockets URL
     * @param {Notebook} notebook - notebook object
     * @param {string} name - the kernel type (e.g. python3)
     */
    var Kernel = function (kernel_service_url, ws_url, notebook, name) {
        this.events = notebook.events;

        this.id = null;
        this.name = name;

        this.channels = {
            'shell': null,
            'iopub': null,
            'stdin': null
        };

        this.kernel_service_url = kernel_service_url;
        this.kernel_url = null;
        this.ws_url = ws_url || IPython.utils.get_body_data("wsUrl");
        if (!this.ws_url) {
            // trailing 's' in https will become wss for secure web sockets
            this.ws_url = location.protocol.replace('http', 'ws') + "//" + location.host;
        }

        this.username = "username";
        this.session_id = utils.uuid();
        this._msg_callbacks = {};

        if (typeof(WebSocket) !== 'undefined') {
            this.WebSocket = WebSocket;
        } else if (typeof(MozWebSocket) !== 'undefined') {
            this.WebSocket = MozWebSocket;
        } else {
            alert('Your browser does not have WebSocket support, please try Chrome, Safari or Firefox ≥ 6. Firefox 4 and 5 are also supported by you have to enable WebSockets in about:config.');
        }
        
        this.bind_events();
        this.init_iopub_handlers();
        this.comm_manager = new comm.CommManager(this);
        this.widget_manager = new widgetmanager.WidgetManager(this.comm_manager, notebook);
        
        this.last_msg_id = null;
        this.last_msg_callbacks = {};

        this._autorestart_attempt = 0;
        this._reconnect_attempt = 0;
    };

    /**
     * @function _get_msg
     */
    Kernel.prototype._get_msg = function (msg_type, content, metadata) {
        var msg = {
            header : {
                msg_id : utils.uuid(),
                username : this.username,
                session : this.session_id,
                msg_type : msg_type,
                version : "5.0"
            },
            metadata : metadata || {},
            content : content,
            parent_header : {}
        };
        return msg;
    };

    /**
     * @function bind_events
     */
    Kernel.prototype.bind_events = function () {
        var that = this;
        this.events.on('send_input_reply.Kernel', function(evt, data) { 
            that.send_input_reply(data);
        });

        var record_status = function (evt, info) {
            console.log('Kernel: ' + evt.type + ' (' + info.kernel.id + ')');
        };

        this.events.on('kernel_created.Kernel', record_status);
        this.events.on('kernel_reconnecting.Kernel', record_status);
        this.events.on('kernel_connected.Kernel', record_status);
        this.events.on('kernel_starting.Kernel', record_status);
        this.events.on('kernel_restarting.Kernel', record_status);
        this.events.on('kernel_autorestarting.Kernel', record_status);
        this.events.on('kernel_interrupting.Kernel', record_status);
        this.events.on('kernel_disconnected.Kernel', record_status);
        // these are commented out because they are triggered a lot, but can
        // be uncommented for debugging purposes
        //this.events.on('kernel_idle.Kernel', record_status);
        //this.events.on('kernel_busy.Kernel', record_status);
        this.events.on('kernel_ready.Kernel', record_status);
        this.events.on('kernel_killed.Kernel', record_status);
        this.events.on('kernel_dead.Kernel', record_status);

        this.events.on('kernel_ready.Kernel', function () {
            that._autorestart_attempt = 0;
        });
        this.events.on('kernel_connected.Kernel', function () {
            that._reconnect_attempt = 0;
        });
    };

    /**
     * Initialize the iopub handlers.
     *
     * @function init_iopub_handlers
     */
    Kernel.prototype.init_iopub_handlers = function () {
        var output_msg_types = ['stream', 'display_data', 'execute_result', 'error'];
        this._iopub_handlers = {};
        this.register_iopub_handler('status', $.proxy(this._handle_status_message, this));
        this.register_iopub_handler('clear_output', $.proxy(this._handle_clear_output, this));
        
        for (var i=0; i < output_msg_types.length; i++) {
            this.register_iopub_handler(output_msg_types[i], $.proxy(this._handle_output_message, this));
        }
    };

    /**
     * GET /api/kernels
     *
     * Get the list of running kernels.
     *
     * @function list
     * @param {function} [success] - function executed on ajax success
     * @param {function} [error] - functon executed on ajax error
     */
    Kernel.prototype.list = function (success, error) {
        $.ajax(this.kernel_service_url, {
            processData: false,
            cache: false,
            type: "GET",
            dataType: "json",
            success: success,
            error: this._on_error(error)
        });
    };

    /**
     * POST /api/kernels
     *
     * Start a new kernel.
     *
     * In general this shouldn't be used -- the kernel should be
     * started through the session API. If you use this function and
     * are also using the session API then your session and kernel
     * WILL be out of sync!
     *
     * @function start
     * @param {params} [Object] - parameters to include in the query string
     * @param {function} [success] - function executed on ajax success
     * @param {function} [error] - functon executed on ajax error
     */
    Kernel.prototype.start = function (params, success, error) {
        var url = this.kernel_service_url;
        var qs = $.param(params || {}); // query string for sage math stuff
        if (qs !== "") {
            url = url + "?" + qs;
        }

        var that = this;
        var on_success = function (data, status, xhr) {
            that.events.trigger('kernel_created.Kernel', {kernel: that});
            that._kernel_created(data);
            if (success) {
                success(data, status, xhr);
            }
        };

        $.ajax(url, {
            processData: false,
            cache: false,
            type: "POST",
            data: JSON.stringify({name: this.name}),
            dataType: "json",
            success: this._on_success(on_success),
            error: this._on_error(error)
        });

        return url;
    };

    /**
     * GET /api/kernels/[:kernel_id]
     *
     * Get information about the kernel.
     *
     * @function get_info
     * @param {function} [success] - function executed on ajax success
     * @param {function} [error] - functon executed on ajax error
     */
    Kernel.prototype.get_info = function (success, error) {
        $.ajax(this.kernel_url, {
            processData: false,
            cache: false,
            type: "GET",
            dataType: "json",
            success: this._on_success(success),
            error: this._on_error(error)
        });
    };

    /**
     * DELETE /api/kernels/[:kernel_id]
     *
     * Shutdown the kernel.
     *
     * If you are also using sessions, then this function shoul NOT be
     * used. Instead, use Session.delete. Otherwise, the session and
     * kernel WILL be out of sync.
     *
     * @function kill
     * @param {function} [success] - function executed on ajax success
     * @param {function} [error] - functon executed on ajax error
     */
    Kernel.prototype.kill = function (success, error) {
        this.events.trigger('kernel_killed.Kernel', {kernel: this});
        this._kernel_dead();
        $.ajax(this.kernel_url, {
            processData: false,
            cache: false,
            type: "DELETE",
            dataType: "json",
            success: this._on_success(success),
            error: this._on_error(error)
        });
    };

    /**
     * POST /api/kernels/[:kernel_id]/interrupt
     *
     * Interrupt the kernel.
     *
     * @function interrupt
     * @param {function} [success] - function executed on ajax success
     * @param {function} [error] - functon executed on ajax error
     */
    Kernel.prototype.interrupt = function (success, error) {
        this.events.trigger('kernel_interrupting.Kernel', {kernel: this});

        var that = this;
        var on_success = function (data, status, xhr) {
            // get kernel info so we know what state the kernel is in
            that.kernel_info();
            if (success) {
                success(data, status, xhr);
            }
        };

        var url = utils.url_join_encode(this.kernel_url, 'interrupt');
        $.ajax(url, {
            processData: false,
            cache: false,
            type: "POST",
            dataType: "json",
            success: this._on_success(on_success),
            error: this._on_error(error)
        });
    };

    /**
     * POST /api/kernels/[:kernel_id]/restart
     *
     * Restart the kernel.
     *
     * @function interrupt
     * @param {function} [success] - function executed on ajax success
     * @param {function} [error] - functon executed on ajax error
     */
    Kernel.prototype.restart = function (success, error) {
        this.events.trigger('kernel_restarting.Kernel', {kernel: this});
        this.stop_channels();

        var that = this;
        var on_success = function (data, status, xhr) {
            that.events.trigger('kernel_created.Kernel', {kernel: that});
            that._kernel_created(data);
            if (success) {
                success(data, status, xhr);
            }
        };

        var on_error = function (xhr, status, err) {
            that.events.trigger('kernel_dead.Kernel', {kernel: that});
            that._kernel_dead();
            if (error) {
                error(xhr, status, err);
            }
        };

        var url = utils.url_join_encode(this.kernel_url, 'restart');
        $.ajax(url, {
            processData: false,
            cache: false,
            type: "POST",
            dataType: "json",
            success: this._on_success(on_success),
            error: this._on_error(on_error)
        });
    };

    /**
     * Reconnect to a disconnected kernel. This is not actually a
     * standard HTTP request, but useful function nonetheless for
     * reconnecting to the kernel if the connection is somehow lost.
     *
     * @function reconnect
     */
    Kernel.prototype.reconnect = function () {
        this.events.trigger('kernel_reconnecting.Kernel', {kernel: this});
        setTimeout($.proxy(this.start_channels, this), 3000);
    };

    /**
     * Handle a successful AJAX request by updating the kernel id and
     * name from the response, and then optionally calling a provided
     * callback.
     *
     * @function _on_success
     * @param {function} success - callback
     */
    Kernel.prototype._on_success = function (success) {
        var that = this;
        return function (data, status, xhr) {
            if (data) {
                that.id = data.id;
                that.name = data.name;
            }
            that.kernel_url = utils.url_join_encode(that.kernel_service_url, that.id);
            if (success) {
                success(data, status, xhr);
            }
        };
    };

    /**
     * Handle a failed AJAX request by logging the error message, and
     * then optionally calling a provided callback.
     *
     * @function _on_error
     * @param {function} error - callback
     */
    Kernel.prototype._on_error = function (error) {
        return function (xhr, status, err) {
            utils.log_ajax_error(xhr, status, err);
            if (error) {
                error(xhr, status, err);
            }
        };
    };

    /**
     * Perform necessary tasks once the kernel has been started,
     * including actually connecting to the kernel.
     *
     * @function _kernel_created
     * @param {Object} data - information about the kernel including id
     */
    Kernel.prototype._kernel_created = function (data) {
        this.id = data.id;
        this.kernel_url = utils.url_join_encode(this.kernel_service_url, this.id);
        this.start_channels();
    };

    /**
     * Perform necessary tasks once the connection to the kernel has
     * been established. This includes requesting information about
     * the kernel.
     *
     * @function _kernel_connected
     */
    Kernel.prototype._kernel_connected = function () {
        this.events.trigger('kernel_connected.Kernel', {kernel: this});
        this.events.trigger('kernel_starting.Kernel', {kernel: this});
        // get kernel info so we know what state the kernel is in
        var that = this;
        this.kernel_info(function () {
            that.events.trigger('kernel_ready.Kernel', {kernel: that});
        });
    };

    /**
     * Perform necessary tasks after the kernel has died. This closing
     * communication channels to the kernel if they are still somehow
     * open.
     *
     * @function _kernel_dead
     */
    Kernel.prototype._kernel_dead = function () {
        this.stop_channels();
    };

    /**
     * Start the `shell`and `iopub` channels.
     * Will stop and restart them if they already exist.
     *
     * @function start_channels
     */
    Kernel.prototype.start_channels = function () {
        var that = this;
        this.stop_channels();
        var ws_host_url = this.ws_url + this.kernel_url;

        console.log("Starting WebSockets:", ws_host_url);
        
        var channel_url = function(channel) {
            return [
                that.ws_url,
                utils.url_join_encode(that.kernel_url, channel),
                "?session_id=" + that.session_id
            ].join('');
        };
        this.channels.shell = new this.WebSocket(channel_url("shell"));
        this.channels.stdin = new this.WebSocket(channel_url("stdin"));
        this.channels.iopub = new this.WebSocket(channel_url("iopub"));
        
        var already_called_onclose = false; // only alert once
        var ws_closed_early = function(evt){
            if (already_called_onclose){
                return;
            }
            already_called_onclose = true;
            if ( ! evt.wasClean ){
                // If the websocket was closed early, that could mean
                // that the kernel is actually dead. Try getting
                // information about the kernel from the API call --
                // if that fails, then assume the kernel is dead,
                // otherwise just follow the typical websocket closed
                // protocol.
                that.get_info(function () {
                    that._ws_closed(ws_host_url, false);
                }, function () {
                    that.events.trigger('kernel_dead.Kernel', {kernel: that});
                    that._kernel_dead();
                });
            }
        };
        var ws_closed_late = function(evt){
            if (already_called_onclose){
                return;
            }
            already_called_onclose = true;
            if ( ! evt.wasClean ){
                that._ws_closed(ws_host_url, false);
            }
        };
        var ws_error = function(evt){
            if (already_called_onclose){
                return;
            }
            already_called_onclose = true;
            that._ws_closed(ws_host_url, true);
        };

        for (var c in this.channels) {
            this.channels[c].onopen = $.proxy(this._ws_opened, this);
            this.channels[c].onclose = ws_closed_early;
            this.channels[c].onerror = ws_error;
        }
        // switch from early-close to late-close message after 1s
        setTimeout(function() {
            for (var c in that.channels) {
                if (that.channels[c] !== null) {
                    that.channels[c].onclose = ws_closed_late;
                }
            }
        }, 1000);
        this.channels.shell.onmessage = $.proxy(this._handle_shell_reply, this);
        this.channels.iopub.onmessage = $.proxy(this._handle_iopub_message, this);
        this.channels.stdin.onmessage = $.proxy(this._handle_input_request, this);
    };

    /**
     * Handle a websocket entering the open state,
     * signaling that the kernel is connected when all channels are open.
     *
     * @function _ws_opened
     */
    Kernel.prototype._ws_opened = function (evt) {
        if (this.is_connected()) {
            // all events ready, trigger started event.
            this._kernel_connected();
        }
    };

    /**
     * Handle a websocket entering the closed state. This closes the
     * other communication channels if they are open. If the websocket
     * was not closed due to an error, try to reconnect to the kernel.
     *
     * @function _ws_closed
     * @param {string} ws_url - the websocket url
     * @param {bool} error - whether the connection was closed due to an error
     */
    Kernel.prototype._ws_closed = function(ws_url, error) {
        this.stop_channels();

        this.events.trigger('kernel_disconnected.Kernel', {kernel: this});
        if (error) {
            console.log('WebSocket connection failed: ', ws_url);
            this._reconnect_attempt = this._reconnect_attempt + 1;
            this.events.trigger('kernel_connection_failed.Kernel', {kernel: this, ws_url: ws_url, attempt: this._reconnect_attempt});
        }
        this.reconnect();
    };

    /**
     * Close the websocket channels. After successful close, the value
     * in `this.channels[channel_name]` will be null.
     *
     * @function stop_channels
     */
    Kernel.prototype.stop_channels = function () {
        var that = this;
        var close = function (c) {
            return function () {
                if (that.channels[c] && that.channels[c].readyState === WebSocket.CLOSED) {
                    that.channels[c] = null;
                }
            };
        };
        for (var c in this.channels) {
            if ( this.channels[c] !== null ) {
                if (this.channels[c].readyState === WebSocket.OPEN) {
                    this.channels[c].onclose = close(c);
                    this.channels[c].close();
                } else {
                    close(c)();
                }
            }
        }
    };

    /**
     * Check whether there is a connection to the kernel. This
     * function only returns true if all channel objects have been
     * created and have a state of WebSocket.OPEN.
     *
     * @function is_connected
     * @returns {bool} - whether there is a connection
     */
    Kernel.prototype.is_connected = function () {
        for (var c in this.channels) {
            // if any channel is not ready, then we're not connected
            if (this.channels[c] === null) {
                return false;
            }
            if (this.channels[c].readyState !== WebSocket.OPEN) {
                return false;
            }
        }
        return true;
    };

    /**
     * Check whether the connection to the kernel has been completely
     * severed. This function only returns true if all channel objects
     * are null.
     *
     * @function is_fully_disconnected
     * @returns {bool} - whether the kernel is fully disconnected
     */
    Kernel.prototype.is_fully_disconnected = function () {
        for (var c in this.channels) {
            if (this.channels[c] === null) {
                return true;
            }
        }
        return false;
    };
    
    /**
     * Send a message on the Kernel's shell channel
     *
     * @function send_shell_message
     */
    Kernel.prototype.send_shell_message = function (msg_type, content, callbacks, metadata) {
        if (!this.is_connected()) {
            throw new Error("kernel is not connected");
        }
        var msg = this._get_msg(msg_type, content, metadata);
        this.channels.shell.send(JSON.stringify(msg));
        this.set_callbacks_for_msg(msg.header.msg_id, callbacks);
        return msg.header.msg_id;
    };

    /**
     * Get kernel info
     *
     * @function kernel_info
     * @param callback {function}
     *
     * When calling this method, pass a callback function that expects one argument.
     * The callback will be passed the complete `kernel_info_reply` message documented
     * [here](http://ipython.org/ipython-doc/dev/development/messaging.html#kernel-info)
     */
    Kernel.prototype.kernel_info = function (callback) {
        var callbacks;
        if (callback) {
            callbacks = { shell : { reply : callback } };
        }
        return this.send_shell_message("kernel_info_request", {}, callbacks);
    };

    /**
     * Get info on an object
     *
     * When calling this method, pass a callback function that expects one argument.
     * The callback will be passed the complete `inspect_reply` message documented
     * [here](http://ipython.org/ipython-doc/dev/development/messaging.html#object-information)
     *
     * @function inspect
     * @param code {string}
     * @param cursor_pos {integer}
     * @param callback {function}
     */
    Kernel.prototype.inspect = function (code, cursor_pos, callback) {
        var callbacks;
        if (callback) {
            callbacks = { shell : { reply : callback } };
        }
        
        var content = {
            code : code,
            cursor_pos : cursor_pos,
            detail_level : 0
        };
        return this.send_shell_message("inspect_request", content, callbacks);
    };

    /**
     * Execute given code into kernel, and pass result to callback.
     *
     * @async
     * @function execute
     * @param {string} code
     * @param [callbacks] {Object} With the following keys (all optional)
     *      @param callbacks.shell.reply {function}
     *      @param callbacks.shell.payload.[payload_name] {function}
     *      @param callbacks.iopub.output {function}
     *      @param callbacks.iopub.clear_output {function}
     *      @param callbacks.input {function}
     * @param {object} [options]
     *      @param [options.silent=false] {Boolean}
     *      @param [options.user_expressions=empty_dict] {Dict}
     *      @param [options.allow_stdin=false] {Boolean} true|false
     *
     * @example
     *
     * The options object should contain the options for the execute
     * call. Its default values are:
     *
     *      options = {
     *        silent : true,
     *        user_expressions : {},
     *        allow_stdin : false
     *      }
     *
     * When calling this method pass a callbacks structure of the
     * form:
     *
     *      callbacks = {
     *       shell : {
     *         reply : execute_reply_callback,
     *         payload : {
     *           set_next_input : set_next_input_callback,
     *         }
     *       },
     *       iopub : {
     *         output : output_callback,
     *         clear_output : clear_output_callback,
     *       },
     *       input : raw_input_callback
     *      }
     *
     * Each callback will be passed the entire message as a single
     * arugment.  Payload handlers will be passed the corresponding
     * payload and the execute_reply message.
     */
    Kernel.prototype.execute = function (code, callbacks, options) {
        var content = {
            code : code,
            silent : true,
            store_history : false,
            user_expressions : {},
            allow_stdin : false
        };
        callbacks = callbacks || {};
        if (callbacks.input !== undefined) {
            content.allow_stdin = true;
        }
        $.extend(true, content, options);
        this.events.trigger('execution_request.Kernel', {kernel: this, content: content});
        return this.send_shell_message("execute_request", content, callbacks);
    };

    /**
     * When calling this method, pass a function to be called with the
     * `complete_reply` message as its only argument when it arrives.
     *
     * `complete_reply` is documented
     * [here](http://ipython.org/ipython-doc/dev/development/messaging.html#complete)
     *
     * @function complete
     * @param code {string}
     * @param cursor_pos {integer}
     * @param callback {function}
     */
    Kernel.prototype.complete = function (code, cursor_pos, callback) {
        var callbacks;
        if (callback) {
            callbacks = { shell : { reply : callback } };
        }
        var content = {
            code : code,
            cursor_pos : cursor_pos
        };
        return this.send_shell_message("complete_request", content, callbacks);
    };

    /**
     * @function send_input_reply
     */
    Kernel.prototype.send_input_reply = function (input) {
        if (!this.is_connected()) {
            throw new Error("kernel is not connected");
        }
        var content = {
            value : input
        };
        this.events.trigger('input_reply.Kernel', {kernel: this, content: content});
        var msg = this._get_msg("input_reply", content);
        this.channels.stdin.send(JSON.stringify(msg));
        return msg.header.msg_id;
    };

    /**
     * @function register_iopub_handler
     */
    Kernel.prototype.register_iopub_handler = function (msg_type, callback) {
        this._iopub_handlers[msg_type] = callback;
    };

    /**
     * Get the iopub handler for a specific message type.
     *
     * @function get_iopub_handler
     */
    Kernel.prototype.get_iopub_handler = function (msg_type) {
        return this._iopub_handlers[msg_type];
    };

    /**
     * Get callbacks for a specific message.
     *
     * @function get_callbacks_for_msg
     */
    Kernel.prototype.get_callbacks_for_msg = function (msg_id) {
        if (msg_id == this.last_msg_id) {
            return this.last_msg_callbacks;
        } else {
            return this._msg_callbacks[msg_id];
        }
    };

    /**
     * Clear callbacks for a specific message.
     *
     * @function clear_callbacks_for_msg
     */
    Kernel.prototype.clear_callbacks_for_msg = function (msg_id) {
        if (this._msg_callbacks[msg_id] !== undefined ) {
            delete this._msg_callbacks[msg_id];
        }
    };
    
    /**
     * @function _finish_shell
     */
    Kernel.prototype._finish_shell = function (msg_id) {
        var callbacks = this._msg_callbacks[msg_id];
        if (callbacks !== undefined) {
            callbacks.shell_done = true;
            if (callbacks.iopub_done) {
                this.clear_callbacks_for_msg(msg_id);
            }
        }
    };

    /**
     * @function _finish_iopub
     */
    Kernel.prototype._finish_iopub = function (msg_id) {
        var callbacks = this._msg_callbacks[msg_id];
        if (callbacks !== undefined) {
            callbacks.iopub_done = true;
            if (callbacks.shell_done) {
                this.clear_callbacks_for_msg(msg_id);
            }
        }
    };
    
    /**
     * Set callbacks for a particular message.
     * Callbacks should be a struct of the following form:
     * shell : {
     * 
     * }
     *
     * @function set_callbacks_for_msg
     */
    Kernel.prototype.set_callbacks_for_msg = function (msg_id, callbacks) {
        this.last_msg_id = msg_id;
        if (callbacks) {
            // shallow-copy mapping, because we will modify it at the top level
            var cbcopy = this._msg_callbacks[msg_id] = this.last_msg_callbacks = {};
            cbcopy.shell = callbacks.shell;
            cbcopy.iopub = callbacks.iopub;
            cbcopy.input = callbacks.input;
            cbcopy.shell_done = (!callbacks.shell);
            cbcopy.iopub_done = (!callbacks.iopub);
        } else {
            this.last_msg_callbacks = {};
        }
    };

    /**
     * @function _handle_shell_reply
     */
    Kernel.prototype._handle_shell_reply = function (e) {
        var reply = $.parseJSON(e.data);
        this.events.trigger('shell_reply.Kernel', {kernel: this, reply: reply});
        var content = reply.content;
        var metadata = reply.metadata;
        var parent_id = reply.parent_header.msg_id;
        var callbacks = this.get_callbacks_for_msg(parent_id);
        if (!callbacks || !callbacks.shell) {
            return;
        }
        var shell_callbacks = callbacks.shell;
        
        // signal that shell callbacks are done
        this._finish_shell(parent_id);
        
        if (shell_callbacks.reply !== undefined) {
            shell_callbacks.reply(reply);
        }
        if (content.payload && shell_callbacks.payload) {
            this._handle_payloads(content.payload, shell_callbacks.payload, reply);
        }
    };

    /**
     * @function _handle_payloads
     */
    Kernel.prototype._handle_payloads = function (payloads, payload_callbacks, msg) {
        var l = payloads.length;
        // Payloads are handled by triggering events because we don't want the Kernel
        // to depend on the Notebook or Pager classes.
        for (var i=0; i<l; i++) {
            var payload = payloads[i];
            var callback = payload_callbacks[payload.source];
            if (callback) {
                callback(payload, msg);
            }
        }
    };

    /**
     * @function _handle_status_message
     */
    Kernel.prototype._handle_status_message = function (msg) {
        var execution_state = msg.content.execution_state;
        var parent_id = msg.parent_header.msg_id;
        
        // dispatch status msg callbacks, if any
        var callbacks = this.get_callbacks_for_msg(parent_id);
        if (callbacks && callbacks.iopub && callbacks.iopub.status) {
            try {
                callbacks.iopub.status(msg);
            } catch (e) {
                console.log("Exception in status msg handler", e, e.stack);
            }
        }
        
        if (execution_state === 'busy') {
            this.events.trigger('kernel_busy.Kernel', {kernel: this});

        } else if (execution_state === 'idle') {
            // signal that iopub callbacks are (probably) done
            // async output may still arrive,
            // but only for the most recent request
            this._finish_iopub(parent_id);
            
            // trigger status_idle event
            this.events.trigger('kernel_idle.Kernel', {kernel: this});

        } else if (execution_state === 'starting') {
            this.events.trigger('kernel_starting.Kernel', {kernel: this});
            var that = this;
            this.kernel_info(function () {
                that.events.trigger('kernel_ready.Kernel', {kernel: that});
            });

        } else if (execution_state === 'restarting') {
            // autorestarting is distinct from restarting,
            // in that it means the kernel died and the server is restarting it.
            // kernel_restarting sets the notification widget,
            // autorestart shows the more prominent dialog.
            this._autorestart_attempt = this._autorestart_attempt + 1;
            this.events.trigger('kernel_restarting.Kernel', {kernel: this});
            this.events.trigger('kernel_autorestarting.Kernel', {kernel: this, attempt: this._autorestart_attempt});

        } else if (execution_state === 'dead') {
            this.events.trigger('kernel_dead.Kernel', {kernel: this});
            this._kernel_dead();
        }
    };
    
    /**
     * Handle clear_output message
     *
     * @function _handle_clear_output
     */
    Kernel.prototype._handle_clear_output = function (msg) {
        var callbacks = this.get_callbacks_for_msg(msg.parent_header.msg_id);
        if (!callbacks || !callbacks.iopub) {
            return;
        }
        var callback = callbacks.iopub.clear_output;
        if (callback) {
            callback(msg);
        }
    };

    /**
     * handle an output message (execute_result, display_data, etc.)
     *
     * @function _handle_output_message
     */
    Kernel.prototype._handle_output_message = function (msg) {
        var callbacks = this.get_callbacks_for_msg(msg.parent_header.msg_id);
        if (!callbacks || !callbacks.iopub) {
            return;
        }
        var callback = callbacks.iopub.output;
        if (callback) {
            callback(msg);
        }
    };

    /**
     * Dispatch IOPub messages to respective handlers. Each message
     * type should have a handler.
     *
     * @function _handle_iopub_message
     */
    Kernel.prototype._handle_iopub_message = function (e) {
        var msg = $.parseJSON(e.data);

        var handler = this.get_iopub_handler(msg.header.msg_type);
        if (handler !== undefined) {
            handler(msg);
        }
    };

    /**
     * @function _handle_input_request
     */
    Kernel.prototype._handle_input_request = function (e) {
        var request = $.parseJSON(e.data);
        var header = request.header;
        var content = request.content;
        var metadata = request.metadata;
        var msg_type = header.msg_type;
        if (msg_type !== 'input_request') {
            console.log("Invalid input request!", request);
            return;
        }
        var callbacks = this.get_callbacks_for_msg(request.parent_header.msg_id);
        if (callbacks) {
            if (callbacks.input) {
                callbacks.input(request);
            }
        }
    };

    // Backwards compatability.
    IPython.Kernel = Kernel;

    return {'Kernel': Kernel};
});
