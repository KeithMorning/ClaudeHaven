#!/usr/bin/python3
"""Compact GTK file browser for the shared workspace."""

import os
import shutil
import sys
from pathlib import Path

import gi

gi.require_version("Gdk", "3.0")
gi.require_version("GdkPixbuf", "2.0")
gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, GdkPixbuf, Gio, GLib, Gtk, Pango

from haven_window import clip_rounded_window, install_resize_handles


CSS = b"""
window, #frame { background: transparent; }
#frame { background: #171514; border: 1px solid #5c4234; border-radius: 12px; }
#titlebar { background: #211b19; border-radius: 11px 11px 0 0; border-bottom: 1px solid #46362e; }
#titlebar label { color: #f4eee8; font: 600 16px 'DejaVu Sans'; }
#titlebar button { background: transparent; border: 0; border-radius: 0; box-shadow: none; color: #eee4dc; min-width: 48px; min-height: 53px; padding: 0; margin: 0; font: 18px 'DejaVu Sans'; }
#titlebar button:hover { background: #3c2b24; }
#titlebar button.close-window:hover { background: #c83227; color: white; }
#toolbar { background: #211c19; border-bottom: 1px solid #46362e; padding: 6px 12px; }
#toolbar button { background: #302824; color: #f1e8e0; border: 1px solid #44352f; border-radius: 5px; box-shadow: none; min-width: 30px; min-height: 30px; padding: 0; font: 16px 'DejaVu Sans'; }
#toolbar button:hover { background: #493127; border-color: #a8613d; }
#toolbar button:disabled { color: #746b65; background: #272320; }
#toolbar entry { background: #191818; color: #f6eee8; border: 1px solid #6e4d3b; border-radius: 5px; min-height: 30px; padding: 0 8px; font: 13px 'DejaVu Sans'; }
#toolbar entry:focus { border-color: #d18355; }
#sidebar { background: #1c1918; border-right: 1px solid #3d332e; padding: 12px 10px 0 12px; }
#sidebar .section { color: #a99589; font: 600 12px 'DejaVu Sans'; letter-spacing: 2px; }
#sidebar button { background: #3b302b; color: #f3e7dc; border: 0; border-radius: 6px; box-shadow: none; min-height: 30px; padding: 0 8px; font: 13px 'DejaVu Sans'; }
#sidebar button:hover { background: #4a362c; }
#files { background: #171514; }
#files flowboxchild { border: 1px solid transparent; border-radius: 6px; background: transparent; padding: 3px; }
#files flowboxchild:hover { background: #30251f; border-color: #5d3d2d; }
#files flowboxchild:selected { background: #412b21; border-color: #e4864e; }
#files flowboxchild label { color: #efe8e1; font: 13px 'DejaVu Sans'; }
#statusbar { background: #211b19; border-top: 1px solid #46362e; color: #ddd0c5; padding: 0 14px; }
#statusbar label { color: #ddd0c5; font: 12px 'DejaVu Sans'; }
scrollbar.vertical { background: #201c1a; min-width: 10px; }
scrollbar.vertical slider { min-width: 6px; margin: 2px; border-radius: 6px; background: #985b3d; }
scrollbar.vertical slider:hover { background: #d58050; }
menu { background: #28221f; color: #f2e8e0; border: 1px solid #694b3a; }
menuitem:hover { background: #5b3929; }
"""


def human_size(value):
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if value < 1024 or unit == "TiB":
            return f"{value:.1f} {unit}" if unit != "B" else f"{value} B"
        value /= 1024


class HavenFiles(Gtk.Application):
    def __init__(self):
        super().__init__(application_id="com.claudehaven.Files",
                         flags=Gio.ApplicationFlags.HANDLES_COMMAND_LINE)
        self.window = None
        self.current = Path("/workspace")
        self.back = []
        self.forward = []
        self.entries = []
        self.hidden_count = 0
        self.show_hidden = False
        self.list_mode = False
        self.monitor = None
        self.refresh_source = 0
        self.copied_paths = []
        self.cut_paths = False

    def do_command_line(self, command_line):
        args = [a.decode() if isinstance(a, bytes) else a
                for a in command_line.get_arguments()]
        if self.window is None:
            self.build_window()
        self.navigate(Path(args[1]) if len(args) > 1 else self.current)
        self.window.show_all()
        if not self.search_visible:
            self.search_entry.hide()
        self.window.present()
        return 0

    def build_window(self):
        provider = Gtk.CssProvider()
        provider.load_from_data(CSS)
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(), provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        self.window = Gtk.ApplicationWindow(application=self)
        self.window.set_decorated(False)
        self.window.set_resizable(True)
        display = self.window.get_display()
        monitor = display.get_primary_monitor() or display.get_monitor(0)
        if monitor:
            bounds = monitor.get_geometry()
            self.window.set_default_size(min(1160, bounds.width - 64),
                                         min(760, bounds.height - 122))
        else:
            self.window.set_default_size(960, 640)
        self.window.set_size_request(670, 440)
        self.window.set_position(Gtk.WindowPosition.CENTER)
        self.window.set_title("workspace")
        self.window.set_icon_from_file("/opt/icons/folder.png")
        screen = self.window.get_screen()
        visual = screen.get_rgba_visual()
        if visual:
            self.window.set_visual(visual)
            self.window.set_app_paintable(True)
        self.window.connect("size-allocate", lambda widget, rect:
                            clip_rounded_window(widget, rect.width, rect.height))
        self.window.connect("map-event", lambda widget, _event:
                            GLib.idle_add(clip_rounded_window, widget,
                                          widget.get_allocated_width(),
                                          widget.get_allocated_height()))
        self.window.connect("key-press-event", self.on_key)
        self.window.connect("destroy", self.on_destroy)

        overlay = Gtk.Overlay()
        self.window.add(overlay)
        frame = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        frame.set_name("frame")
        overlay.add(frame)
        install_resize_handles(overlay, self.window)

        title = Gtk.EventBox()
        title.set_name("titlebar")
        title.set_size_request(-1, 54)
        title.connect("button-press-event", self.start_drag)
        row = Gtk.Box(spacing=10)
        row.set_margin_start(16)
        title.add(row)
        row.pack_start(Gtk.Image.new_from_pixbuf(
            GdkPixbuf.Pixbuf.new_from_file_at_scale(
                "/opt/icons/folder.png", 30, 30, True)), False, False, 0)
        self.title_label = Gtk.Label(label="workspace")
        row.pack_start(self.title_label, False, False, 0)
        row.pack_start(Gtk.Box(), True, True, 0)
        controls = Gtk.Box(spacing=0)
        for text, callback in (("−", self.window.iconify),
                               ("□", self.toggle_maximize), ("×", self.window.close)):
            button = Gtk.Button(label=text)
            if text == "×":
                button.get_style_context().add_class("close-window")
            button.connect("clicked", lambda _button, action=callback: action())
            controls.pack_start(button, False, False, 0)
        row.pack_start(controls, False, False, 0)
        frame.pack_start(title, False, False, 0)

        toolbar = Gtk.Box(spacing=6)
        toolbar.set_name("toolbar")
        self.back_button = self.tool_button(toolbar, "‹", self.go_back, "Back")
        self.forward_button = self.tool_button(toolbar, "›", self.go_forward, "Forward")
        self.tool_button(toolbar, "↑", self.go_up, "Parent folder")
        self.location = Gtk.Entry()
        self.location.set_name("location")
        self.location.set_width_chars(12)
        self.location.set_icon_from_pixbuf(
            Gtk.EntryIconPosition.PRIMARY,
            GdkPixbuf.Pixbuf.new_from_file_at_scale(
                "/opt/icons/folder.png", 16, 16, True))
        self.location.connect("activate", self.on_location_activate)
        toolbar.pack_start(self.location, True, True, 3)
        self.search_button = self.tool_button(toolbar, "⌕", self.toggle_search, "Search")
        search_icon = Gtk.Image.new_from_icon_name("system-search-symbolic",
                                                   Gtk.IconSize.BUTTON)
        search_icon.set_pixel_size(16)
        self.search_button.set_image(search_icon)
        self.search_button.set_always_show_image(True)
        self.search_button.set_label("")
        self.view_button = self.tool_button(toolbar, "▦", self.toggle_view, "Grid / list")
        self.tool_button(toolbar, "⋯", self.show_menu, "More")
        frame.pack_start(toolbar, False, False, 0)

        body = Gtk.Box()
        frame.pack_start(body, True, True, 0)
        sidebar = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        sidebar.set_name("sidebar")
        sidebar.set_size_request(176, -1)
        heading = Gtk.Label(label="PLACES", xalign=0)
        heading.get_style_context().add_class("section")
        sidebar.pack_start(heading, False, False, 0)
        home = Gtk.Button()
        home_content = Gtk.Box(spacing=8)
        home_content.pack_start(Gtk.Image.new_from_pixbuf(
            GdkPixbuf.Pixbuf.new_from_file_at_scale(
                "/opt/icons/folder.png", 26, 26, True)), False, False, 0)
        home_content.pack_start(Gtk.Label(label="Workspace"), False, False, 0)
        home.add(home_content)
        home.connect("clicked", lambda _button: self.navigate(Path("/workspace")))
        sidebar.pack_start(home, False, False, 0)
        body.pack_start(sidebar, False, False, 0)

        content = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        content.set_name("files")
        body.pack_start(content, True, True, 0)
        self.search_entry = Gtk.SearchEntry()
        self.search_entry.set_placeholder_text("Search this folder")
        self.search_entry.set_margin_start(16)
        self.search_entry.set_margin_end(16)
        self.search_entry.set_margin_top(12)
        self.search_entry.connect("search-changed", lambda _entry: self.render())
        self.search_visible = False
        content.pack_start(self.search_entry, False, False, 0)
        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scroll.set_overlay_scrolling(False)
        self.flow = Gtk.FlowBox()
        self.flow.set_valign(Gtk.Align.START)
        self.flow.set_selection_mode(Gtk.SelectionMode.MULTIPLE)
        self.flow.set_activate_on_single_click(False)
        self.flow.set_row_spacing(6)
        self.flow.set_column_spacing(6)
        self.flow.set_margin_start(12)
        self.flow.set_margin_end(12)
        self.flow.set_margin_top(12)
        self.flow.set_margin_bottom(12)
        self.flow.connect("child-activated", self.open_child)
        scroll.add(self.flow)
        content.pack_start(scroll, True, True, 0)

        status = Gtk.Box(spacing=12)
        status.set_name("statusbar")
        status.set_size_request(-1, 32)
        self.count_label = Gtk.Label(xalign=0)
        status.pack_start(self.count_label, False, False, 0)
        status.pack_start(Gtk.Box(), True, True, 0)
        self.space_label = Gtk.Label(xalign=1)
        status.pack_start(self.space_label, False, False, 0)
        frame.pack_start(status, False, False, 0)

    def tool_button(self, parent, text, callback, tooltip):
        button = Gtk.Button(label=text)
        button.set_tooltip_text(tooltip)
        button.connect("clicked", callback)
        parent.pack_start(button, False, False, 0)
        return button

    def navigate(self, target, record=True):
        try:
            target = Path(os.path.abspath(target.expanduser()))
            if not target.is_dir():
                raise NotADirectoryError(str(target))
        except (OSError, RuntimeError) as error:
            self.error(str(error))
            return
        if record and target != self.current:
            self.back.append(self.current)
            self.forward.clear()
        self.current = target
        self.location.set_text(str(target))
        self.title_label.set_text(target.name or str(target))
        self.window.set_title(target.name or str(target))
        self.back_button.set_sensitive(bool(self.back))
        self.forward_button.set_sensitive(bool(self.forward))
        self.search_entry.set_text("")
        self.refresh()

    def refresh(self):
        try:
            with os.scandir(self.current) as iterator:
                self.entries = [(Path(item.path), item.is_dir()) for item in iterator]
        except OSError as error:
            self.entries = []
            self.error(str(error))
        self.entries.sort(key=lambda item: (not item[1], item[0].name.casefold()))
        self.hidden_count = sum(path.name.startswith(".") for path, _ in self.entries)
        self.render()
        if self.monitor:
            self.monitor.cancel()
        try:
            self.monitor = Gio.File.new_for_path(str(self.current)).monitor_directory(
                Gio.FileMonitorFlags.NONE, None)
            self.monitor.connect("changed", self.on_files_changed)
        except GLib.Error:
            self.monitor = None

    def on_files_changed(self, *_args):
        if not self.refresh_source:
            self.refresh_source = GLib.timeout_add(300, self.refresh_delayed)

    def refresh_delayed(self):
        self.refresh_source = 0
        self.refresh()
        return False

    def render(self):
        for child in self.flow.get_children():
            self.flow.remove(child)
        query = self.search_entry.get_text().casefold()
        visible = [(path, is_dir) for path, is_dir in self.entries
                   if (self.show_hidden or not path.name.startswith("."))
                   and query in path.name.casefold()]
        self.flow.set_max_children_per_line(1 if self.list_mode else 8)
        self.flow.set_min_children_per_line(1 if self.list_mode else 2)
        icon_size = 22 if self.list_mode else 44
        folder = GdkPixbuf.Pixbuf.new_from_file_at_scale(
            "/opt/icons/folder.png", icon_size, icon_size, True)
        for path, is_dir in visible:
            tile = Gtk.Box(orientation=(Gtk.Orientation.HORIZONTAL if self.list_mode
                                        else Gtk.Orientation.VERTICAL),
                           spacing=8 if self.list_mode else 3)
            tile.set_size_request(-1 if self.list_mode else 112,
                                  26 if self.list_mode else 66)
            tile.set_valign(Gtk.Align.CENTER)
            if is_dir:
                image = Gtk.Image.new_from_pixbuf(folder)
            else:
                content_type, _uncertain = Gio.content_type_guess(str(path), None)
                image = Gtk.Image.new_from_gicon(Gio.content_type_get_icon(content_type),
                                                 Gtk.IconSize.DIALOG)
                image.set_pixel_size(icon_size)
            tile.pack_start(image, False, False, 0)
            label = Gtk.Label(label=path.name)
            label.set_max_width_chars(25 if self.list_mode else 18)
            label.set_ellipsize(Pango.EllipsizeMode.MIDDLE)
            label.set_tooltip_text(path.name)
            tile.pack_start(label, False, False, 0)
            child = Gtk.FlowBoxChild()
            child.file_path = path
            child.add(tile)
            child.connect("button-press-event", self.on_child_click)
            self.flow.add(child)
        self.flow.show_all()
        shown = len(visible)
        self.count_label.set_text(f"▱   {shown} items ({self.hidden_count} hidden)")
        try:
            usage = shutil.disk_usage(self.current)
            self.space_label.set_text(f"◉   Free space: {human_size(usage.free)}  "
                                      f"(Total: {human_size(usage.total)})")
        except OSError:
            self.space_label.set_text("")

    def open_child(self, _flow, child):
        path = child.file_path
        if path.is_dir():
            self.navigate(path)
        else:
            try:
                Gio.AppInfo.launch_default_for_uri(path.as_uri(), None)
            except GLib.Error as error:
                self.error(str(error))

    def on_child_click(self, child, event):
        if event.button == 3:
            self.flow.select_child(child)
            self.show_item_menu(child.file_path, event)
            return True
        return False

    def show_item_menu(self, path, event):
        menu = Gtk.Menu()
        for text, callback in (("Open", lambda: self.open_path(path)),
                               ("Copy", lambda: self.copy_selected(False)),
                               ("Cut", lambda: self.copy_selected(True)),
                               ("Rename", lambda: self.rename(path)),
                               ("Move to Trash", lambda: self.trash(path))):
            item = Gtk.MenuItem(label=text)
            item.connect("activate", lambda _item, action=callback: action())
            menu.append(item)
        menu.show_all()
        menu.popup_at_pointer(event)

    def open_path(self, path):
        if path.is_dir():
            self.navigate(path)
        else:
            try:
                Gio.AppInfo.launch_default_for_uri(path.as_uri(), None)
            except GLib.Error as error:
                self.error(str(error))

    def show_menu(self, *_args):
        menu = Gtk.Menu()
        options = (("New folder", self.new_folder),
                   ("Paste", self.paste),
                   ("Refresh", self.refresh),
                   ("Show hidden files" if not self.show_hidden else "Hide hidden files",
                    self.toggle_hidden))
        for text, callback in options:
            item = Gtk.MenuItem(label=text)
            item.connect("activate", lambda _item, action=callback: action())
            menu.append(item)
        menu.show_all()
        menu.popup_at_pointer(None)

    def ask_name(self, title, initial=""):
        dialog = Gtk.Dialog(title=title, transient_for=self.window, modal=True)
        dialog.add_button("Cancel", Gtk.ResponseType.CANCEL)
        dialog.add_button("Save", Gtk.ResponseType.OK)
        entry = Gtk.Entry(text=initial)
        entry.set_activates_default(True)
        entry.set_margin_start(18)
        entry.set_margin_end(18)
        entry.set_margin_top(16)
        entry.set_margin_bottom(16)
        dialog.get_content_area().add(entry)
        dialog.set_default_response(Gtk.ResponseType.OK)
        dialog.show_all()
        response = dialog.run()
        value = entry.get_text().strip() if response == Gtk.ResponseType.OK else None
        dialog.destroy()
        if value is not None and (not value or value in (".", "..") or "/" in value):
            self.error("Choose a valid file name.")
            return None
        return value

    def new_folder(self):
        name = self.ask_name("New folder")
        if name:
            try:
                (self.current / name).mkdir()
                self.refresh()
            except OSError as error:
                self.error(str(error))

    def rename(self, path):
        name = self.ask_name("Rename", path.name)
        if name and name != path.name:
            target = path.with_name(name)
            if target.exists():
                self.error("A file with that name already exists.")
                return
            try:
                path.rename(target)
                self.refresh()
            except OSError as error:
                self.error(str(error))

    def trash(self, path):
        try:
            Gio.File.new_for_path(str(path)).trash(None)
            self.refresh()
        except GLib.Error as error:
            self.error(f"Could not move to Trash: {error.message}")

    def copy_selected(self, cut):
        selected = self.flow.get_selected_children()
        if not selected:
            return
        self.copied_paths = [child.file_path for child in selected]
        self.cut_paths = cut

    def paste(self):
        sources = self.copied_paths
        if not sources:
            return
        cut = self.cut_paths
        failed = False
        for source in sources:
            target = self.current / source.name
            if target.exists() or (source.is_dir() and source in target.parents):
                self.error(f"A file with this name already exists: {target.name}")
                failed = True
                continue
            try:
                if cut:
                    shutil.move(str(source), str(target))
                elif source.is_dir():
                    shutil.copytree(source, target, symlinks=True)
                else:
                    shutil.copy2(source, target, follow_symlinks=False)
            except OSError as error:
                self.error(str(error))
                failed = True
        if cut and not failed:
            self.copied_paths = []
            self.cut_paths = False
        self.refresh()

    def error(self, message):
        dialog = Gtk.MessageDialog(transient_for=self.window, modal=True,
                                   message_type=Gtk.MessageType.ERROR,
                                   buttons=Gtk.ButtonsType.CLOSE, text=message)
        dialog.run()
        dialog.destroy()

    def on_location_activate(self, entry):
        self.navigate(Path(entry.get_text()))

    def go_back(self, *_args):
        if self.back:
            target = self.back.pop()
            self.forward.append(self.current)
            self.navigate(target, record=False)

    def go_forward(self, *_args):
        if self.forward:
            target = self.forward.pop()
            self.back.append(self.current)
            self.navigate(target, record=False)

    def go_up(self, *_args):
        self.navigate(self.current.parent)

    def toggle_search(self, *_args):
        self.search_visible = not self.search_visible
        if self.search_visible:
            self.search_entry.show()
            self.search_entry.grab_focus()
        else:
            self.search_entry.set_text("")
            self.search_entry.hide()

    def toggle_view(self, *_args):
        self.list_mode = not self.list_mode
        self.view_button.set_label("☷" if self.list_mode else "▦")
        self.render()

    def toggle_hidden(self):
        self.show_hidden = not self.show_hidden
        self.render()

    def on_key(self, _widget, event):
        control = bool(event.state & Gdk.ModifierType.CONTROL_MASK)
        alt = bool(event.state & Gdk.ModifierType.MOD1_MASK)
        key = Gdk.keyval_name(event.keyval).lower()
        if isinstance(self.window.get_focus(), Gtk.Entry) and not (
                control and key in ("l", "f")):
            return False
        if control and key == "l":
            self.location.grab_focus()
            self.location.select_region(0, -1)
        elif control and key == "f":
            if not self.search_visible:
                self.toggle_search()
            else:
                self.search_entry.grab_focus()
        elif control and key == "n":
            self.new_folder()
        elif control and key == "c":
            self.copy_selected(False)
        elif control and key == "x":
            self.copy_selected(True)
        elif control and key == "v":
            self.paste()
        elif control and key == "a":
            self.flow.select_all()
        elif alt and key == "left":
            self.go_back()
        elif alt and key == "right":
            self.go_forward()
        elif alt and key == "up":
            self.go_up()
        elif key == "f5":
            self.refresh()
        elif key == "f2" and self.flow.get_selected_children():
            self.rename(self.flow.get_selected_children()[0].file_path)
        elif key == "delete" and self.flow.get_selected_children():
            self.trash(self.flow.get_selected_children()[0].file_path)
        else:
            return False
        return True

    def start_drag(self, _widget, event):
        if event.button == 1:
            self.window.begin_move_drag(1, int(event.x_root), int(event.y_root), event.time)

    def toggle_maximize(self):
        if self.window.is_maximized():
            self.window.unmaximize()
        else:
            self.window.maximize()

    def on_destroy(self, *_args):
        if self.monitor:
            self.monitor.cancel()


if __name__ == "__main__":
    sys.exit(HavenFiles().run(sys.argv))
