"""Native fixture UI only. Never targets the user's ordinary application."""
import ctypes as c
import pathlib
import re
import subprocess

cf = c.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
ax = c.CDLL('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')
p = c.c_void_p
for library, name, result, args in [
    (cf, 'CFStringCreateWithCString', p, [p, c.c_char_p, c.c_uint32]),
    (cf, 'CFStringGetCString', c.c_bool, [p, p, c.c_long, c.c_uint32]),
    (cf, 'CFGetTypeID', c.c_ulong, [p]),
    (cf, 'CFStringGetTypeID', c.c_ulong, []),
    (cf, 'CFArrayGetTypeID', c.c_ulong, []),
    (cf, 'CFArrayGetCount', c.c_long, [p]),
    (cf, 'CFArrayGetValueAtIndex', p, [p, c.c_long]),
    (cf, 'CFRelease', None, [p]),
    (cf, 'CFBooleanGetValue', c.c_bool, [p]),
    (ax, 'AXIsProcessTrusted', c.c_bool, []),
    (ax, 'AXUIElementCreateApplication', p, [c.c_int]),
    (ax, 'AXUIElementCopyAttributeValue', c.c_int, [p, p, c.POINTER(p)]),
    (ax, 'AXUIElementSetAttributeValue', c.c_int, [p, p, p]),
    (ax, 'AXUIElementPerformAction', c.c_int, [p, p]),
    (ax, 'CGEventCreateKeyboardEvent', p, [p, c.c_uint16, c.c_bool]),
    (ax, 'CGEventKeyboardSetUnicodeString', None, [p, c.c_ulong, p]),
    (ax, 'CGEventSetFlags', None, [p, c.c_uint64]),
    (ax, 'CGEventPostToPid', None, [c.c_int, p]),
]:
    function = getattr(library, name)
    function.restype = result
    function.argtypes = args


def string(text):
    return cf.CFStringCreateWithCString(None, text.encode(), 0x08000100)


def attribute(element, name):
    key = string(name)
    value = p()
    error = ax.AXUIElementCopyAttributeValue(element, key, c.byref(value))
    cf.CFRelease(key)
    return value.value if not error else None


def label(element, name):
    value = attribute(element, name)
    try:
        if value and cf.CFGetTypeID(value) == cf.CFStringGetTypeID():
            buffer = c.create_string_buffer(4096)
            if cf.CFStringGetCString(value, buffer, len(buffer), 0x08000100):
                return buffer.value.decode(errors='replace')
        return None
    finally:
        if value:
            cf.CFRelease(value)


class NoControl(RuntimeError):
    """No action was attempted; callers may wait for the control to appear."""


class FixtureUi:
    def __init__(self, pid):
        self.pid = pid
        self.executable = pathlib.Path(subprocess.check_output(
            ['/bin/ps', '-p', str(pid), '-o', 'comm='], text=True).strip()).resolve()
        repo = pathlib.Path(__file__).resolve().parents[2]
        if not self.executable.is_relative_to(repo / 'artifacts'):
            raise RuntimeError('Refusing a non-fixture application')
        identifier = subprocess.check_output([
            '/usr/libexec/PlistBuddy', '-c', 'Print :CFBundleIdentifier',
            str(self.executable.parents[1] / 'Info.plist'),
        ], text=True).strip()
        if identifier != 'org.agentworkspace.performance':
            raise RuntimeError('Refusing the ordinary user application or test driver')
        if not ax.AXIsProcessTrusted():
            raise RuntimeError('Accessibility permission unavailable; no prompt requested')

    def alive(self):
        result = subprocess.run(['/bin/ps', '-p', str(self.pid), '-o', 'comm='],
                                capture_output=True, text=True)
        return result.returncode == 0 and result.stdout.strip() == str(self.executable)

    def nodes(self):
        if not self.alive():
            raise RuntimeError('The owned fixture exited')
        root = ax.AXUIElementCreateApplication(self.pid)
        visited = 0

        def walk(element, depth=0):
            nonlocal visited
            visited += 1
            if visited > 5000 or depth > 60:
                raise RuntimeError('Accessibility tree exceeded fixture bounds')
            role = label(element, 'AXRole')
            if role == 'AXMenuBar':
                return  # OS menus can contain unrelated recent documents.
            yield element, role
            children = attribute(element, 'AXChildren')
            if children:
                try:
                    if cf.CFGetTypeID(children) == cf.CFArrayGetTypeID():
                        for index in range(cf.CFArrayGetCount(children)):
                            yield from walk(cf.CFArrayGetValueAtIndex(children, index), depth + 1)
                finally:
                    cf.CFRelease(children)
        try:
            yield from walk(root)
        finally:
            cf.CFRelease(root)

    def describe(self):
        # Do not read AXValue: it can contain editor source or shell output.
        result = []
        for element, role in self.nodes():
            if role not in ('AXTextArea', 'AXTextField', 'AXRadioButton', 'AXButton', 'AXHeading', 'AXWindow'):
                continue
            focused = attribute(element, 'AXFocused')
            try:
                result.append({'role': role, 'label': label(element, 'AXTitle'),
                               'focused': cf.CFBooleanGetValue(focused) if focused else None})
            finally:
                if focused:
                    cf.CFRelease(focused)
        return result

    def has(self, name):
        return any(label(element, 'AXTitle') == name for element, _ in self.nodes())

    def field_equals(self, name, expected):
        if name != 'File name':
            raise RuntimeError('Only the fixture filename query may be compared')
        return any(role == 'AXTextField' and label(element, 'AXTitle') == name
                   and label(element, 'AXValue') == expected for element, role in self.nodes())

    def press(self, name):
        for element, role in self.nodes():
            if role in ('AXButton', 'AXPopUpButton', 'AXCheckBox') and name in (
                    label(element, 'AXTitle'), label(element, 'AXDescription')):
                enabled = attribute(element, 'AXEnabled')
                if enabled:
                    try:
                        if not cf.CFBooleanGetValue(enabled):
                            raise NoControl(name + ' (disabled)')
                    finally:
                        cf.CFRelease(enabled)
                action = string('AXPress')
                try:
                    error = ax.AXUIElementPerformAction(element, action)
                finally:
                    cf.CFRelease(action)
                if error:
                    raise RuntimeError(f'AXPress outcome unavailable ({error}); do not retry it')
                return
        raise NoControl(name)

    def focus(self, name):
        for element, _ in self.nodes():
            if label(element, 'AXTitle') == name:
                key = string('AXFocused')
                try:
                    error = ax.AXUIElementSetAttributeValue(
                        element, key, p.in_dll(cf, 'kCFBooleanTrue'))
                finally:
                    cf.CFRelease(key)
                if error:
                    raise RuntimeError(f'Native focus unavailable ({error})')
                return
        raise NoControl(name)

    def key(self, code, flags=0, text=None):
        if not self.alive():
            raise RuntimeError('Fixture process identity changed')
        asn = subprocess.check_output(['/usr/bin/lsappinfo', 'front'], text=True).strip()
        info = subprocess.check_output(['/usr/bin/lsappinfo', 'info', '-only', 'pid', asn], text=True)
        if not re.search(r'"pid"=' + str(self.pid) + r'\b', info):
            raise RuntimeError('Fixture lost native foreground; refusing input')
        for down in (True, False):
            event = ax.CGEventCreateKeyboardEvent(None, code, down)
            try:
                ax.CGEventSetFlags(event, flags)
                if text is not None:
                    raw = text.encode('utf-16-le')
                    buffer = c.create_string_buffer(raw)
                    ax.CGEventKeyboardSetUnicodeString(event, len(raw) // 2, buffer)
                ax.CGEventPostToPid(self.pid, event)
            finally:
                cf.CFRelease(event)
