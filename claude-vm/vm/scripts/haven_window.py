"""Shared borderless window behavior for the VM desktop apps."""

import ctypes
import math

import gi

gi.require_version("Gdk", "3.0")
gi.require_version("GdkX11", "3.0")
gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, GdkX11, Gtk


class XRectangle(ctypes.Structure):
    _fields_ = [("x", ctypes.c_short), ("y", ctypes.c_short),
                ("width", ctypes.c_ushort), ("height", ctypes.c_ushort)]


def clip_rounded_window(window, width, height):
    gdk_window = window.get_window()
    if not gdk_window or width < 24 or height < 24:
        return
    radius = 12
    rectangles = [XRectangle(0, radius, width, height - radius * 2)]
    for y in range(radius):
        edge = math.ceil(radius - math.sqrt(radius * radius - (radius - y - .5) ** 2))
        rectangles.append(XRectangle(edge, y, width - edge * 2, 1))
        rectangles.append(XRectangle(edge, height - y - 1, width - edge * 2, 1))

    x11 = ctypes.CDLL("libX11.so.6")
    xext = ctypes.CDLL("libXext.so.6")
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    x11.XFlush.argtypes = [ctypes.c_void_p]
    xext.XShapeQueryExtension.argtypes = [
        ctypes.c_void_p, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
    ]
    xext.XShapeQueryExtension.restype = ctypes.c_int
    xext.XShapeCombineRectangles.argtypes = [
        ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int,
        ctypes.c_int, ctypes.POINTER(XRectangle), ctypes.c_int,
        ctypes.c_int, ctypes.c_int,
    ]
    display = x11.XOpenDisplay(None)
    if not display:
        return
    try:
        event_base = ctypes.c_int()
        error_base = ctypes.c_int()
        if not xext.XShapeQueryExtension(display, ctypes.byref(event_base),
                                        ctypes.byref(error_base)):
            return
        data = (XRectangle * len(rectangles))(*rectangles)
        xext.XShapeCombineRectangles(
            display, GdkX11.X11Window.get_xid(gdk_window), 0, 0, 0,
            data, len(rectangles), 0, 0,
        )
        x11.XFlush(display)
    finally:
        x11.XCloseDisplay(display)


def install_resize_handles(overlay, window):
    """Keep eight draggable edges above the content of an undecorated window."""
    positions = (
        (Gdk.WindowEdge.NORTH, Gtk.Align.FILL, Gtk.Align.START, -1, 7,
         Gdk.CursorType.TOP_SIDE),
        (Gdk.WindowEdge.SOUTH, Gtk.Align.FILL, Gtk.Align.END, -1, 7,
         Gdk.CursorType.BOTTOM_SIDE),
        (Gdk.WindowEdge.WEST, Gtk.Align.START, Gtk.Align.FILL, 7, -1,
         Gdk.CursorType.LEFT_SIDE),
        (Gdk.WindowEdge.EAST, Gtk.Align.END, Gtk.Align.FILL, 7, -1,
         Gdk.CursorType.RIGHT_SIDE),
        (Gdk.WindowEdge.NORTH_WEST, Gtk.Align.START, Gtk.Align.START, 12, 12,
         Gdk.CursorType.TOP_LEFT_CORNER),
        (Gdk.WindowEdge.NORTH_EAST, Gtk.Align.END, Gtk.Align.START, 12, 12,
         Gdk.CursorType.TOP_RIGHT_CORNER),
        (Gdk.WindowEdge.SOUTH_WEST, Gtk.Align.START, Gtk.Align.END, 12, 12,
         Gdk.CursorType.BOTTOM_LEFT_CORNER),
        (Gdk.WindowEdge.SOUTH_EAST, Gtk.Align.END, Gtk.Align.END, 12, 12,
         Gdk.CursorType.BOTTOM_RIGHT_CORNER),
    )
    for edge, halign, valign, width, height, cursor_type in positions:
        handle = Gtk.EventBox()
        handle.set_visible_window(False)
        handle.set_halign(halign)
        handle.set_valign(valign)
        handle.set_size_request(width, height)

        def resize(_widget, event, side=edge):
            if event.button != 1 or window.is_maximized():
                return False
            window.begin_resize_drag(side, event.button, int(event.x_root),
                                     int(event.y_root), event.time)
            return True

        def cursor(widget, _event, shape=cursor_type):
            if widget.get_window():
                widget.get_window().set_cursor(
                    Gdk.Cursor.new_for_display(Gdk.Display.get_default(), shape))

        handle.connect("button-press-event", resize)
        handle.connect("enter-notify-event", cursor)
        handle.connect("leave-notify-event", lambda widget, _event:
                       widget.get_window().set_cursor(None) if widget.get_window() else None)
        overlay.add_overlay(handle)
