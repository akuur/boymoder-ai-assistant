#![cfg(target_os = "linux")]

use gtk::glib::ObjectType as _;
use gtk::prelude::WidgetExt as _;
use std::ffi::{c_char, c_int, c_void, CStr};
use std::sync::OnceLock;

const LAYER_BOTTOM: c_int = 1;
const LAYER_OVERLAY: c_int = 3;

const EDGE_LEFT: c_int = 0;
const EDGE_RIGHT: c_int = 1;
const EDGE_TOP: c_int = 2;
const EDGE_BOTTOM: c_int = 3;

const KEYBOARD_MODE_NONE: c_int = 0;

struct LayerShellApi {
    is_supported: unsafe extern "C" fn() -> c_int,
    init_for_window: unsafe extern "C" fn(window: *mut c_void),
    is_layer_window: unsafe extern "C" fn(window: *mut c_void) -> c_int,
    set_namespace: unsafe extern "C" fn(window: *mut c_void, ns: *const c_char),
    set_layer: unsafe extern "C" fn(window: *mut c_void, layer: c_int),
    set_anchor: unsafe extern "C" fn(window: *mut c_void, edge: c_int, anchor: c_int),
    set_exclusive_zone: unsafe extern "C" fn(window: *mut c_void, zone: c_int),
    set_keyboard_mode: unsafe extern "C" fn(window: *mut c_void, mode: c_int),
}

static API: OnceLock<Option<LayerShellApi>> = OnceLock::new();

fn load_api() -> Option<&'static LayerShellApi> {
    API.get_or_init(|| unsafe {
        let candidates = [
            b"libgtk-layer-shell.so.0\0".as_slice(),
            b"libgtk-layer-shell.so\0".as_slice(),
        ];
        let mut handle: *mut c_void = std::ptr::null_mut();
        for name in candidates {
            handle = libc::dlopen(name.as_ptr() as *const c_char, libc::RTLD_LAZY | libc::RTLD_LOCAL);
            if !handle.is_null() {
                break;
            }
        }
        if handle.is_null() {
            return None;
        }

        macro_rules! sym {
            ($name:literal, $ty:ty) => {{
                let p = libc::dlsym(handle, concat!($name, "\0").as_ptr() as *const c_char);
                if p.is_null() {
                    return None;
                }
                std::mem::transmute::<*mut c_void, $ty>(p)
            }};
        }

        Some(LayerShellApi {
            is_supported: sym!("gtk_layer_is_supported", unsafe extern "C" fn() -> c_int),
            init_for_window: sym!("gtk_layer_init_for_window", unsafe extern "C" fn(*mut c_void)),
            is_layer_window: sym!("gtk_layer_is_layer_window", unsafe extern "C" fn(*mut c_void) -> c_int),
            set_namespace: sym!("gtk_layer_set_namespace", unsafe extern "C" fn(*mut c_void, *const c_char)),
            set_layer: sym!("gtk_layer_set_layer", unsafe extern "C" fn(*mut c_void, c_int)),
            set_anchor: sym!("gtk_layer_set_anchor", unsafe extern "C" fn(*mut c_void, c_int, c_int)),
            set_exclusive_zone: sym!("gtk_layer_set_exclusive_zone", unsafe extern "C" fn(*mut c_void, c_int)),
            set_keyboard_mode: sym!("gtk_layer_set_keyboard_mode", unsafe extern "C" fn(*mut c_void, c_int)),
        })
    })
    .as_ref()
}

fn raw_gtk_window(gtk_app_win: &gtk::ApplicationWindow) -> *mut c_void {
    gtk_app_win.as_ptr() as *mut c_void
}

pub fn init_overlay_layer(gtk_app_win: &gtk::ApplicationWindow) -> bool {
    let Some(api) = load_api() else {
        return false;
    };
    unsafe {
        if (api.is_supported)() == 0 {
            return false;
        }
        if gtk_app_win.is_realized() && !gtk_app_win.is_visible() {
            gtk_app_win.unrealize();
        }
        let win = raw_gtk_window(gtk_app_win);
        if (api.is_layer_window)(win) == 0 {
            (api.init_for_window)(win);
        }
        let ns = CStr::from_bytes_with_nul_unchecked(b"boymoder-pets\0");
        (api.set_namespace)(win, ns.as_ptr());
        (api.set_layer)(win, LAYER_OVERLAY);
        (api.set_anchor)(win, EDGE_LEFT, 1);
        (api.set_anchor)(win, EDGE_RIGHT, 1);
        (api.set_anchor)(win, EDGE_TOP, 1);
        (api.set_anchor)(win, EDGE_BOTTOM, 1);
        (api.set_exclusive_zone)(win, 0);
        (api.set_keyboard_mode)(win, KEYBOARD_MODE_NONE);
        true
    }
}

pub fn set_overlay_layer_top(gtk_app_win: &gtk::ApplicationWindow, on_top: bool) -> bool {
    let Some(api) = load_api() else {
        return false;
    };
    unsafe {
        if (api.is_supported)() == 0 {
            return false;
        }
        let win = raw_gtk_window(gtk_app_win);
        if (api.is_layer_window)(win) == 0 {
            return false;
        }
        (api.set_layer)(win, if on_top { LAYER_OVERLAY } else { LAYER_BOTTOM });
        true
    }
}

pub fn is_layer_active(gtk_app_win: &gtk::ApplicationWindow) -> bool {
    let Some(api) = load_api() else {
        return false;
    };
    unsafe { (api.is_supported)() != 0 && (api.is_layer_window)(raw_gtk_window(gtk_app_win)) != 0 }
}
