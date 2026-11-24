#!/usr/bin/python3
"""Claude Haven's small GTK shell around the existing VTE terminal engine."""
import sys

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("GdkPixbuf", "2.0")
gi.require_version("Vte", "2.91")
from gi.repository import Gdk, GdkPixbuf, Gio, GLib, Gtk, Pango, Vte

from haven_window import clip_rounded_window, install_resize_handles


DEFAULT_FONT_SIZE = 13
MIN_FONT_SIZE = 8
MAX_FONT_SIZE = 28

CSS = b"""
window, #frame { background: transparent; }
#frame { background: #141414; border: 1px solid #4b4947; border-radius: 12px; }
#titlebar { background: #1b1a19; border-radius: 11px 11px 0 0; border-bottom: 1px solid #373330; }
#titlebar label { color: #f3efeb; font: 600 16px 'DejaVu Sans'; }
#tabs { background: #171615; border-bottom: 1px solid #373330; min-height: 44px; }
#tabs .tab { background: transparent; border-radius: 9px 9px 0 0; border-bottom: 2px solid transparent; }
#tabs .tab:hover { background: #28231f; }
#tabs .tab.active { background: #2b2521; border-bottom-color: #ff914b; }
#tabs .tab button { background: transparent; border: 0; box-shadow: none; color: #ded8d2; font: 500 14px 'DejaVu Sans'; }
#tabs .tab button.tab-switch { padding: 7px 0 7px 16px; }
#tabs .tab button.close-tab { min-width: 38px; min-height: 38px; padding: 0; margin: 0 7px 0 2px; border-radius: 7px; font: 20px 'DejaVu Sans'; }
#tabs .tab button.close-tab:hover { background: #4b3227; color: #ffffff; }
#tabs button#add-tab { background: transparent; border: 0; box-shadow: none; color: #ded8d2; min-width: 36px; }
#titlebar button { background: transparent; border: 0; border-radius: 0; box-shadow: none; color: #e4d9ce; min-width: 48px; min-height: 53px; padding: 0; margin: 0; font: 18px 'DejaVu Sans'; }
#titlebar button:hover { background: #3a2b24; }
#titlebar button.close-window:hover { background: #c83227; color: #ffffff; }
#frame scrollbar.vertical { background: transparent; min-width: 8px; }
#frame scrollbar.vertical slider { min-width: 4px; margin: 1px; border-radius: 5px; background: #8c553a; }
#frame scrollbar.vertical slider:hover { background: #d47b49; }
"""


def color(value):
    rgba = Gdk.RGBA()
    rgba.parse(value)
    return rgba


class HavenTerminal(Gtk.Application):
    def __init__(self):
        super().__init__(application_id="com.claudehaven.Terminal",
                         flags=Gio.ApplicationFlags.HANDLES_COMMAND_LINE)
        self.window = None
        self.tabs = []
        self.font_size = DEFAULT_FONT_SIZE

    def do_command_line(self, command_line):
        args = [arg.decode() if isinstance(arg, bytes) else arg
                for arg in command_line.get_arguments()]
        kind = "claude" if "--claude" in args else "shell"
        if self.window is None:
            self.create_window()
        tab = next((item for item in self.tabs if item[5] == kind), None)
        if tab:
            self.activate(tab)
        else:
            self.add_tab(kind)
        self.window.present()
        return 0

    def create_window(self):
        provider = Gtk.CssProvider()
        provider.load_from_data(CSS)
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(), provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        self.window = Gtk.ApplicationWindow(application=self)
        self.window.set_decorated(False)
        self.window.connect("size-allocate", lambda widget, allocation:
                            clip_rounded_window(widget, allocation.width, allocation.height))
        self.window.connect("map-event", lambda widget, _event:
                            GLib.idle_add(clip_rounded_window, widget,
                                          widget.get_allocated_width(),
                                          widget.get_allocated_height()))
        monitor = Gdk.Display.get_default().get_primary_monitor().get_geometry()
        self.window.set_default_size(min(1460, monitor.width - 64),
                                     min(850, monitor.height - 122))
        self.window.set_position(Gtk.WindowPosition.CENTER)
        self.window.set_size_request(680, 420)
        visual = self.window.get_screen().get_rgba_visual()
        if visual:
            self.window.set_visual(visual)
            self.window.set_app_paintable(True)

        frame = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        frame.set_name("frame")
        overlay = Gtk.Overlay()
        self.window.add(overlay)
        overlay.add(frame)
        install_resize_handles(overlay, self.window)

        title = Gtk.EventBox()
        title.set_name("titlebar")
        title.set_size_request(-1, 54)
        title.connect("button-press-event", self.start_drag)
        title_row = Gtk.Box(spacing=9)
        title_row.set_margin_start(16)
        title_row.set_margin_end(0)
        title.add(title_row)
        self.title_icon = Gtk.Image.new_from_pixbuf(GdkPixbuf.Pixbuf.new_from_file_at_scale(
            "/opt/icons/terminal.png", 28, 28, True))
        title_row.pack_start(self.title_icon, False, False, 0)
        self.title_label = Gtk.Label(label="Terminal — /workspace")
        title_row.pack_start(self.title_label, False, False, 0)
        title_row.pack_start(Gtk.Box(), True, True, 0)
        controls = Gtk.Box(spacing=0)
        for text, action in (("−", self.window.iconify),
                             ("□", self.toggle_maximize), ("×", self.window.close)):
            button = Gtk.Button(label=text)
            if text == "×":
                button.get_style_context().add_class("close-window")
            button.connect("clicked", lambda _button, callback=action: callback())
            controls.pack_start(button, False, False, 0)
        title_row.pack_start(controls, False, False, 0)
        frame.pack_start(title, False, False, 0)

        self.tab_row = Gtk.Box(spacing=2)
        self.tab_row.set_name("tabs")
        self.tab_row.set_margin_start(0)
        frame.pack_start(self.tab_row, False, False, 0)
        self.pages = Gtk.Stack()
        self.pages.set_margin_start(20)
        self.pages.set_margin_top(14)
        self.pages.set_margin_end(12)
        self.pages.set_margin_bottom(10)
        frame.pack_start(self.pages, True, True, 0)

    def start_drag(self, _widget, event):
        if event.button == 1:
            self.window.begin_move_drag(1, int(event.x_root), int(event.y_root), event.time)

    def toggle_maximize(self):
        if self.window.is_maximized():
            self.window.unmaximize()
        else:
            self.window.maximize()

    def add_tab(self, kind):
        name = "Claude Code" if kind == "claude" else "Terminal"
        icon = "/opt/icons/claude.png" if kind == "claude" else "/opt/icons/terminal.png"
        tab_button = Gtk.Box()
        tab_button.get_style_context().add_class("tab")
        tab_button.set_size_request(202, -1)
        tab_switch = Gtk.Button()
        tab_switch.get_style_context().add_class("tab-switch")
        tab_content = Gtk.Box(spacing=9)
        tab_content.pack_start(Gtk.Image.new_from_pixbuf(
            GdkPixbuf.Pixbuf.new_from_file_at_scale(icon, 24, 24, True)), False, False, 0)
        tab_content.pack_start(Gtk.Label(label=name), False, False, 0)
        close = Gtk.Button(label="×")
        close.get_style_context().add_class("close-tab")
        close.set_relief(Gtk.ReliefStyle.NONE)
        close.set_size_request(38, 38)
        tab_switch.add(tab_content)
        tab_button.pack_start(tab_switch, True, True, 0)
        tab_button.pack_end(close, False, False, 0)
        self.tab_row.pack_start(tab_button, False, False, 0)
        add = next((child for child in self.tab_row.get_children()
                    if child.get_name() == "add-tab"), None)
        if add:
            self.tab_row.reorder_child(add, -1)
        else:
            add = Gtk.Button(label="+")
            add.set_name("add-tab")
            add.connect("clicked", lambda _button: self.add_tab("shell"))
            self.tab_row.pack_start(add, False, False, 0)

        terminal = Vte.Terminal()
        terminal.set_font(self.terminal_font())
        terminal.set_cell_height_scale(1.12)
        terminal.set_scrollback_lines(8000)
        terminal.set_cursor_blink_mode(Vte.CursorBlinkMode.ON)
        terminal.set_colors(color("#f1eeeb"), color("#141414"), [
            color(value) for value in (
                "#1e1e1e", "#ea6e71", "#a7cd76", "#f7ae59",
                "#9e9cc2", "#d197e7", "#e3a36e", "#e8e4e0",
                "#6e6968", "#ff8e8f", "#bee091", "#ffc780",
                "#b8b2d7", "#e0abf3", "#f5b682", "#faf8f6")])
        terminal.connect("key-press-event", self.on_key)
        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scroll.set_overlay_scrolling(False)
        scroll.add(terminal)
        # Gtk.Stack ignores attempts to select a hidden child.
        scroll.show_all()
        self.pages.add_named(scroll, str(id(terminal)))
        tab = (tab_button, scroll, terminal, name, icon, kind)
        self.tabs.append(tab)
        tab_switch.connect("clicked", lambda _button: self.activate(tab))
        close.connect("clicked", lambda _button: self.close_tab(tab))
        terminal.connect("child-exited", lambda _term, status: self.child_exited(tab, status))
        self.activate(tab)
        # Set _NET_WM_ICON before the first map; tint2 keeps the icon it sees
        # when the window first appears.
        self.window.show_all()
        tab[2].grab_focus()
        script = ("/opt/scripts/session-claude.sh" if kind == "claude"
                  else "/opt/scripts/session-shell.sh")
        terminal.spawn_sync(Vte.PtyFlags.DEFAULT, "/workspace", [script], None,
                            GLib.SpawnFlags.DEFAULT, None, None, None)

    def child_exited(self, tab, status):
        print(f"Terminal exited with status {status}", file=sys.stderr, flush=True)
        self.close_tab(tab)

    def activate(self, tab):
        for button, *_ in self.tabs:
            button.get_style_context().remove_class("active")
        tab[0].get_style_context().add_class("active")
        self.pages.set_visible_child(tab[1])
        self.title_label.set_text(f"{tab[3]} — /workspace")
        self.title_icon.set_from_pixbuf(GdkPixbuf.Pixbuf.new_from_file_at_scale(
            tab[4], 28, 28, True))
        self.window.set_title(tab[3])
        self.window.set_icon_from_file(tab[4])
        tab[2].grab_focus()

    def close_tab(self, tab):
        if tab not in self.tabs:
            return
        self.tabs.remove(tab)
        self.tab_row.remove(tab[0])
        self.pages.remove(tab[1])
        if self.tabs:
            self.activate(self.tabs[-1])
        else:
            self.window.close()

    def terminal_font(self):
        return Pango.FontDescription(f"JetBrains Mono Medium {self.font_size}")

    def on_key(self, terminal, event):
        control = bool(event.state & Gdk.ModifierType.CONTROL_MASK)
        key = (Gdk.keyval_name(event.keyval) or "").lower()
        other_modifiers = (Gdk.ModifierType.MOD1_MASK | Gdk.ModifierType.SUPER_MASK
                           | Gdk.ModifierType.META_MASK)
        if control and not (event.state & other_modifiers):
            if key in ("plus", "equal", "kp_add"):
                step = 1
            elif key in ("minus", "underscore", "kp_subtract"):
                step = -1
            else:
                step = 0
            if step:
                size = max(MIN_FONT_SIZE, min(MAX_FONT_SIZE, self.font_size + step))
                if size != self.font_size:
                    self.font_size = size
                    font = self.terminal_font()
                    for tab in self.tabs:
                        tab[2].set_font(font)
                return True
        if control and key == "c" and terminal.get_has_selection():
            terminal.copy_clipboard()
            return True
        if control and key == "v":
            terminal.paste_clipboard()
            return True
        return False


if __name__ == "__main__":
    sys.exit(HavenTerminal().run(sys.argv))
