"""Base class for a Comm"""

# Copyright (c) IPython Development Team.
# Distributed under the terms of the Modified BSD License.

import uuid

from IPython.config import LoggingConfigurable
from IPython.kernel.zmq.kernelbase import Kernel

from IPython.utils.jsonutil import json_clean
from IPython.utils.traitlets import Instance, Unicode, Bytes, Bool, Dict, Any


class Comm(LoggingConfigurable):
    
    # If this is instantiated by a non-IPython kernel, shell will be None
    shell = Instance('IPython.core.interactiveshell.InteractiveShellABC',
                     allow_none=True)
    kernel = Instance('IPython.kernel.zmq.kernelbase.Kernel')
    def _kernel_default(self):
        if Kernel.initialized():
            return Kernel.instance()
    
    iopub_socket = Any()
    def _iopub_socket_default(self):
        return self.kernel.iopub_socket
    session = Instance('IPython.kernel.zmq.session.Session')
    def _session_default(self):
        if self.kernel is not None:
            return self.kernel.session
    
    target_name = Unicode('comm')
    
    topic = Bytes()
    def _topic_default(self):
        return ('comm-%s' % self.comm_id).encode('ascii')
    
    _open_data = Dict(help="data dict, if any, to be included in comm_open")
    _close_data = Dict(help="data dict, if any, to be included in comm_close")
    
    _msg_callback = Any()
    _close_callback = Any()
    
    _closed = Bool(False)
    comm_id = Unicode()
    def _comm_id_default(self):
        return uuid.uuid4().hex
    
    primary = Bool(True, help="Am I the primary or secondary Comm?")
    
    def __init__(self, target_name='', data=None, **kwargs):
        if target_name:
            kwargs['target_name'] = target_name
        super(Comm, self).__init__(**kwargs)
        if self.primary:
            # I am primary, open my peer.
            self.open(data)
    
    def _publish_msg(self, msg_type, data=None, metadata=None, **keys):
        """Helper for sending a comm message on IOPub"""
        data = {} if data is None else data
        metadata = {} if metadata is None else metadata
        content = json_clean(dict(data=data, comm_id=self.comm_id, **keys))
        self.session.send(self.iopub_socket, msg_type,
            content,
            metadata=json_clean(metadata),
            parent=self.kernel._parent_header,
            ident=self.topic,
        )
    
    def __del__(self):
        """trigger close on gc"""
        self.close()
    
    # publishing messages
    
    def open(self, data=None, metadata=None):
        """Open the frontend-side version of this comm"""
        if data is None:
            data = self._open_data
        comm_manager = getattr(self.kernel, 'comm_manager', None)
        if comm_manager is None:
            raise RuntimeError("Comms cannot be opened without a kernel "
                        "and a comm_manager attached to that kernel.")

        comm_manager.register_comm(self)
        self._closed = False
        self._publish_msg('comm_open', data, metadata, target_name=self.target_name)
    
    def close(self, data=None, metadata=None):
        """Close the frontend-side version of this comm"""
        if self._closed:
            # only close once
            return
        if data is None:
            data = self._close_data
        self._publish_msg('comm_close', data, metadata)
        self.kernel.comm_manager.unregister_comm(self)
        self._closed = True
    
    def send(self, data=None, metadata=None):
        """Send a message to the frontend-side version of this comm"""
        self._publish_msg('comm_msg', data, metadata)
    
    # registering callbacks
    
    def on_close(self, callback):
        """Register a callback for comm_close
        
        Will be called with the `data` of the close message.
        
        Call `on_close(None)` to disable an existing callback.
        """
        self._close_callback = callback
    
    def on_msg(self, callback):
        """Register a callback for comm_msg
        
        Will be called with the `data` of any comm_msg messages.
        
        Call `on_msg(None)` to disable an existing callback.
        """
        self._msg_callback = callback
    
    # handling of incoming messages
    
    def handle_close(self, msg):
        """Handle a comm_close message"""
        self.log.debug("handle_close[%s](%s)", self.comm_id, msg)
        if self._close_callback:
            self._close_callback(msg)
    
    def handle_msg(self, msg):
        """Handle a comm_msg message"""
        self.log.debug("handle_msg[%s](%s)", self.comm_id, msg)
        if self._msg_callback:
            if self.shell:
                self.shell.events.trigger('pre_execute')
            self._msg_callback(msg)
            if self.shell:
                self.shell.events.trigger('post_execute')


__all__ = ['Comm']
