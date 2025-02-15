"""Base classes to manage a Client's interaction with a running kernel"""

# Copyright (c) IPython Development Team.
# Distributed under the terms of the Modified BSD License.

from __future__ import absolute_import

import atexit
import errno
from threading import Thread
import time

import zmq
# import ZMQError in top-level namespace, to avoid ugly attribute-error messages
# during garbage collection of threads at exit:
from zmq import ZMQError
from zmq.eventloop import ioloop, zmqstream

from IPython.core.release import kernel_protocol_version_info

from .channelsabc import (
    ShellChannelABC, IOPubChannelABC,
    HBChannelABC, StdInChannelABC,
)
from IPython.utils.py3compat import string_types, iteritems

#-----------------------------------------------------------------------------
# Constants and exceptions
#-----------------------------------------------------------------------------

major_protocol_version = kernel_protocol_version_info[0]

class InvalidPortNumber(Exception):
    pass

#-----------------------------------------------------------------------------
# Utility functions
#-----------------------------------------------------------------------------

# some utilities to validate message structure, these might get moved elsewhere
# if they prove to have more generic utility

def validate_string_list(lst):
    """Validate that the input is a list of strings.

    Raises ValueError if not."""
    if not isinstance(lst, list):
        raise ValueError('input %r must be a list' % lst)
    for x in lst:
        if not isinstance(x, string_types):
            raise ValueError('element %r in list must be a string' % x)


def validate_string_dict(dct):
    """Validate that the input is a dict with string keys and values.

    Raises ValueError if not."""
    for k,v in iteritems(dct):
        if not isinstance(k, string_types):
            raise ValueError('key %r in dict must be a string' % k)
        if not isinstance(v, string_types):
            raise ValueError('value %r in dict must be a string' % v)


#-----------------------------------------------------------------------------
# ZMQ Socket Channel classes
#-----------------------------------------------------------------------------

class ZMQSocketChannel(Thread):
    """The base class for the channels that use ZMQ sockets."""
    context = None
    session = None
    socket = None
    ioloop = None
    stream = None
    _address = None
    _exiting = False
    proxy_methods = []

    def __init__(self, context, session, address):
        """Create a channel.

        Parameters
        ----------
        context : :class:`zmq.Context`
            The ZMQ context to use.
        session : :class:`session.Session`
            The session to use.
        address : zmq url
            Standard (ip, port) tuple that the kernel is listening on.
        """
        super(ZMQSocketChannel, self).__init__()
        self.daemon = True

        self.context = context
        self.session = session
        if isinstance(address, tuple):
            if address[1] == 0:
                message = 'The port number for a channel cannot be 0.'
                raise InvalidPortNumber(message)
            address = "tcp://%s:%i" % address
        self._address = address
        atexit.register(self._notice_exit)

    def _notice_exit(self):
        self._exiting = True

    def _run_loop(self):
        """Run my loop, ignoring EINTR events in the poller"""
        while True:
            try:
                self.ioloop.start()
            except ZMQError as e:
                if e.errno == errno.EINTR:
                    continue
                else:
                    raise
            except Exception:
                if self._exiting:
                    break
                else:
                    raise
            else:
                break

    def stop(self):
        """Stop the channel's event loop and join its thread.

        This calls :meth:`~threading.Thread.join` and returns when the thread
        terminates. :class:`RuntimeError` will be raised if
        :meth:`~threading.Thread.start` is called again.
        """
        if self.ioloop is not None:
            self.ioloop.stop()
        self.join()
        self.close()
    
    def close(self):
        if self.ioloop is not None:
            try:
                self.ioloop.close(all_fds=True)
            except Exception:
                pass
        if self.socket is not None:
            try:
                self.socket.close(linger=0)
            except Exception:
                pass
            self.socket = None

    @property
    def address(self):
        """Get the channel's address as a zmq url string.

        These URLS have the form: 'tcp://127.0.0.1:5555'.
        """
        return self._address

    def _queue_send(self, msg):
        """Queue a message to be sent from the IOLoop's thread.

        Parameters
        ----------
        msg : message to send

        This is threadsafe, as it uses IOLoop.add_callback to give the loop's
        thread control of the action.
        """
        def thread_send():
            self.session.send(self.stream, msg)
        self.ioloop.add_callback(thread_send)

    def _handle_recv(self, msg):
        """Callback for stream.on_recv.

        Unpacks message, and calls handlers with it.
        """
        ident,smsg = self.session.feed_identities(msg)
        msg = self.session.unserialize(smsg)
        self.call_handlers(msg)



class ShellChannel(ZMQSocketChannel):
    """The shell channel for issuing request/replies to the kernel."""

    command_queue = None
    # flag for whether execute requests should be allowed to call raw_input:
    allow_stdin = True
    proxy_methods = [
        'execute',
        'complete',
        'inspect',
        'history',
        'kernel_info',
        'shutdown',
        'is_complete',
    ]

    def __init__(self, context, session, address):
        super(ShellChannel, self).__init__(context, session, address)
        self.ioloop = ioloop.IOLoop()
    
    def run(self):
        """The thread's main activity.  Call start() instead."""
        self.socket = self.context.socket(zmq.DEALER)
        self.socket.linger = 1000
        self.socket.setsockopt(zmq.IDENTITY, self.session.bsession)
        self.socket.connect(self.address)
        self.stream = zmqstream.ZMQStream(self.socket, self.ioloop)
        self.stream.on_recv(self._handle_recv)
        self._run_loop()

    def call_handlers(self, msg):
        """This method is called in the ioloop thread when a message arrives.

        Subclasses should override this method to handle incoming messages.
        It is important to remember that this method is called in the thread
        so that some logic must be done to ensure that the application level
        handlers are called in the application thread.
        """
        raise NotImplementedError('call_handlers must be defined in a subclass.')

    def execute(self, code, silent=False, store_history=True,
                user_expressions=None, allow_stdin=None):
        """Execute code in the kernel.

        Parameters
        ----------
        code : str
            A string of Python code.

        silent : bool, optional (default False)
            If set, the kernel will execute the code as quietly possible, and
            will force store_history to be False.

        store_history : bool, optional (default True)
            If set, the kernel will store command history.  This is forced
            to be False if silent is True.

        user_expressions : dict, optional
            A dict mapping names to expressions to be evaluated in the user's
            dict. The expression values are returned as strings formatted using
            :func:`repr`.

        allow_stdin : bool, optional (default self.allow_stdin)
            Flag for whether the kernel can send stdin requests to frontends.

            Some frontends (e.g. the Notebook) do not support stdin requests.
            If raw_input is called from code executed from such a frontend, a
            StdinNotImplementedError will be raised.

        Returns
        -------
        The msg_id of the message sent.
        """
        if user_expressions is None:
            user_expressions = {}
        if allow_stdin is None:
            allow_stdin = self.allow_stdin


        # Don't waste network traffic if inputs are invalid
        if not isinstance(code, string_types):
            raise ValueError('code %r must be a string' % code)
        validate_string_dict(user_expressions)

        # Create class for content/msg creation. Related to, but possibly
        # not in Session.
        content = dict(code=code, silent=silent, store_history=store_history,
                       user_expressions=user_expressions,
                       allow_stdin=allow_stdin,
                       )
        msg = self.session.msg('execute_request', content)
        self._queue_send(msg)
        return msg['header']['msg_id']

    def complete(self, code, cursor_pos=None):
        """Tab complete text in the kernel's namespace.

        Parameters
        ----------
        code : str
            The context in which completion is requested.
            Can be anything between a variable name and an entire cell.
        cursor_pos : int, optional
            The position of the cursor in the block of code where the completion was requested.
            Default: ``len(code)``

        Returns
        -------
        The msg_id of the message sent.
        """
        if cursor_pos is None:
            cursor_pos = len(code)
        content = dict(code=code, cursor_pos=cursor_pos)
        msg = self.session.msg('complete_request', content)
        self._queue_send(msg)
        return msg['header']['msg_id']

    def inspect(self, code, cursor_pos=None, detail_level=0):
        """Get metadata information about an object in the kernel's namespace.

        It is up to the kernel to determine the appropriate object to inspect.

        Parameters
        ----------
        code : str
            The context in which info is requested.
            Can be anything between a variable name and an entire cell.
        cursor_pos : int, optional
            The position of the cursor in the block of code where the info was requested.
            Default: ``len(code)``
        detail_level : int, optional
            The level of detail for the introspection (0-2)

        Returns
        -------
        The msg_id of the message sent.
        """
        if cursor_pos is None:
            cursor_pos = len(code)
        content = dict(code=code, cursor_pos=cursor_pos,
            detail_level=detail_level,
        )
        msg = self.session.msg('inspect_request', content)
        self._queue_send(msg)
        return msg['header']['msg_id']

    def history(self, raw=True, output=False, hist_access_type='range', **kwargs):
        """Get entries from the kernel's history list.

        Parameters
        ----------
        raw : bool
            If True, return the raw input.
        output : bool
            If True, then return the output as well.
        hist_access_type : str
            'range' (fill in session, start and stop params), 'tail' (fill in n)
             or 'search' (fill in pattern param).

        session : int
            For a range request, the session from which to get lines. Session
            numbers are positive integers; negative ones count back from the
            current session.
        start : int
            The first line number of a history range.
        stop : int
            The final (excluded) line number of a history range.

        n : int
            The number of lines of history to get for a tail request.

        pattern : str
            The glob-syntax pattern for a search request.

        Returns
        -------
        The msg_id of the message sent.
        """
        content = dict(raw=raw, output=output, hist_access_type=hist_access_type,
                                                                    **kwargs)
        msg = self.session.msg('history_request', content)
        self._queue_send(msg)
        return msg['header']['msg_id']

    def kernel_info(self):
        """Request kernel info."""
        msg = self.session.msg('kernel_info_request')
        self._queue_send(msg)
        return msg['header']['msg_id']
    
    def _handle_kernel_info_reply(self, msg):
        """handle kernel info reply
        
        sets protocol adaptation version
        """
        adapt_version = int(msg['content']['protocol_version'].split('.')[0])
        if adapt_version != major_protocol_version:
            self.session.adapt_version = adapt_version

    def shutdown(self, restart=False):
        """Request an immediate kernel shutdown.

        Upon receipt of the (empty) reply, client code can safely assume that
        the kernel has shut down and it's safe to forcefully terminate it if
        it's still alive.

        The kernel will send the reply via a function registered with Python's
        atexit module, ensuring it's truly done as the kernel is done with all
        normal operation.
        """
        # Send quit message to kernel. Once we implement kernel-side setattr,
        # this should probably be done that way, but for now this will do.
        msg = self.session.msg('shutdown_request', {'restart':restart})
        self._queue_send(msg)
        return msg['header']['msg_id']

    def is_complete(self, code):
        msg = self.session.msg('is_complete_request', {'code': code})
        self._queue_send(msg)
        return msg['header']['msg_id']


class IOPubChannel(ZMQSocketChannel):
    """The iopub channel which listens for messages that the kernel publishes.

    This channel is where all output is published to frontends.
    """

    def __init__(self, context, session, address):
        super(IOPubChannel, self).__init__(context, session, address)
        self.ioloop = ioloop.IOLoop()

    def run(self):
        """The thread's main activity.  Call start() instead."""
        self.socket = self.context.socket(zmq.SUB)
        self.socket.linger = 1000
        self.socket.setsockopt(zmq.SUBSCRIBE,b'')
        self.socket.setsockopt(zmq.IDENTITY, self.session.bsession)
        self.socket.connect(self.address)
        self.stream = zmqstream.ZMQStream(self.socket, self.ioloop)
        self.stream.on_recv(self._handle_recv)
        self._run_loop()

    def call_handlers(self, msg):
        """This method is called in the ioloop thread when a message arrives.

        Subclasses should override this method to handle incoming messages.
        It is important to remember that this method is called in the thread
        so that some logic must be done to ensure that the application leve
        handlers are called in the application thread.
        """
        raise NotImplementedError('call_handlers must be defined in a subclass.')

    def flush(self, timeout=1.0):
        """Immediately processes all pending messages on the iopub channel.

        Callers should use this method to ensure that :meth:`call_handlers`
        has been called for all messages that have been received on the
        0MQ SUB socket of this channel.

        This method is thread safe.

        Parameters
        ----------
        timeout : float, optional
            The maximum amount of time to spend flushing, in seconds. The
            default is one second.
        """
        # We do the IOLoop callback process twice to ensure that the IOLoop
        # gets to perform at least one full poll.
        stop_time = time.time() + timeout
        for i in range(2):
            self._flushed = False
            self.ioloop.add_callback(self._flush)
            while not self._flushed and time.time() < stop_time:
                time.sleep(0.01)

    def _flush(self):
        """Callback for :method:`self.flush`."""
        self.stream.flush()
        self._flushed = True


class StdInChannel(ZMQSocketChannel):
    """The stdin channel to handle raw_input requests that the kernel makes."""

    msg_queue = None
    proxy_methods = ['input']

    def __init__(self, context, session, address):
        super(StdInChannel, self).__init__(context, session, address)
        self.ioloop = ioloop.IOLoop()

    def run(self):
        """The thread's main activity.  Call start() instead."""
        self.socket = self.context.socket(zmq.DEALER)
        self.socket.linger = 1000
        self.socket.setsockopt(zmq.IDENTITY, self.session.bsession)
        self.socket.connect(self.address)
        self.stream = zmqstream.ZMQStream(self.socket, self.ioloop)
        self.stream.on_recv(self._handle_recv)
        self._run_loop()

    def call_handlers(self, msg):
        """This method is called in the ioloop thread when a message arrives.

        Subclasses should override this method to handle incoming messages.
        It is important to remember that this method is called in the thread
        so that some logic must be done to ensure that the application leve
        handlers are called in the application thread.
        """
        raise NotImplementedError('call_handlers must be defined in a subclass.')

    def input(self, string):
        """Send a string of raw input to the kernel."""
        content = dict(value=string)
        msg = self.session.msg('input_reply', content)
        self._queue_send(msg)


class HBChannel(ZMQSocketChannel):
    """The heartbeat channel which monitors the kernel heartbeat.

    Note that the heartbeat channel is paused by default. As long as you start
    this channel, the kernel manager will ensure that it is paused and un-paused
    as appropriate.
    """

    time_to_dead = 3.0
    socket = None
    poller = None
    _running = None
    _pause = None
    _beating = None

    def __init__(self, context, session, address):
        super(HBChannel, self).__init__(context, session, address)
        self._running = False
        self._pause =True
        self.poller = zmq.Poller()

    def _create_socket(self):
        if self.socket is not None:
            # close previous socket, before opening a new one
            self.poller.unregister(self.socket)
            self.socket.close()
        self.socket = self.context.socket(zmq.REQ)
        self.socket.linger = 1000
        self.socket.connect(self.address)

        self.poller.register(self.socket, zmq.POLLIN)

    def _poll(self, start_time):
        """poll for heartbeat replies until we reach self.time_to_dead.

        Ignores interrupts, and returns the result of poll(), which
        will be an empty list if no messages arrived before the timeout,
        or the event tuple if there is a message to receive.
        """

        until_dead = self.time_to_dead - (time.time() - start_time)
        # ensure poll at least once
        until_dead = max(until_dead, 1e-3)
        events = []
        while True:
            try:
                events = self.poller.poll(1000 * until_dead)
            except ZMQError as e:
                if e.errno == errno.EINTR:
                    # ignore interrupts during heartbeat
                    # this may never actually happen
                    until_dead = self.time_to_dead - (time.time() - start_time)
                    until_dead = max(until_dead, 1e-3)
                    pass
                else:
                    raise
            except Exception:
                if self._exiting:
                    break
                else:
                    raise
            else:
                break
        return events

    def run(self):
        """The thread's main activity.  Call start() instead."""
        self._create_socket()
        self._running = True
        self._beating = True

        while self._running:
            if self._pause:
                # just sleep, and skip the rest of the loop
                time.sleep(self.time_to_dead)
                continue

            since_last_heartbeat = 0.0
            # io.rprint('Ping from HB channel') # dbg
            # no need to catch EFSM here, because the previous event was
            # either a recv or connect, which cannot be followed by EFSM
            self.socket.send(b'ping')
            request_time = time.time()
            ready = self._poll(request_time)
            if ready:
                self._beating = True
                # the poll above guarantees we have something to recv
                self.socket.recv()
                # sleep the remainder of the cycle
                remainder = self.time_to_dead - (time.time() - request_time)
                if remainder > 0:
                    time.sleep(remainder)
                continue
            else:
                # nothing was received within the time limit, signal heart failure
                self._beating = False
                since_last_heartbeat = time.time() - request_time
                self.call_handlers(since_last_heartbeat)
                # and close/reopen the socket, because the REQ/REP cycle has been broken
                self._create_socket()
                continue

    def pause(self):
        """Pause the heartbeat."""
        self._pause = True

    def unpause(self):
        """Unpause the heartbeat."""
        self._pause = False

    def is_beating(self):
        """Is the heartbeat running and responsive (and not paused)."""
        if self.is_alive() and not self._pause and self._beating:
            return True
        else:
            return False

    def stop(self):
        """Stop the channel's event loop and join its thread."""
        self._running = False
        super(HBChannel, self).stop()

    def call_handlers(self, since_last_heartbeat):
        """This method is called in the ioloop thread when a message arrives.

        Subclasses should override this method to handle incoming messages.
        It is important to remember that this method is called in the thread
        so that some logic must be done to ensure that the application level
        handlers are called in the application thread.
        """
        raise NotImplementedError('call_handlers must be defined in a subclass.')


#---------------------------------------------------------------------#-----------------------------------------------------------------------------
# ABC Registration
#-----------------------------------------------------------------------------

ShellChannelABC.register(ShellChannel)
IOPubChannelABC.register(IOPubChannel)
HBChannelABC.register(HBChannel)
StdInChannelABC.register(StdInChannel)
