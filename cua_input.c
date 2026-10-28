// Native macOS input helper for cua-mcp. One dependency-free binary for the
// whole input path, so the server needs no native npm modules.
//
// Build: clang -framework ApplicationServices -framework CoreFoundation cua_input.c -o cua_input
//
// Commands (coordinates are global display points; main-display logical coords
// map 1:1 since the main display origin is 0,0):
//   move  <x> <y>
//   pos                         -> prints "x y"
//   screen                      -> prints "w h" (main display, logical points)
//   click <x> <y> <left|right|middle> <0|1 double>
//   drag  <x1> <y1> <x2> <y2>
//   scroll <dx> <dy>            (line units; +y up, +x right)
//   type  <text>                (Unicode, layout-independent; no keycodes)
//   key   <combo>               (e.g. "cmd+space", "cmd+shift+4", "enter")
//
// NOTE: move/pos/screen need no permission. click/drag/scroll/type/key post
// input events and require macOS Accessibility permission to take effect.
#include <ApplicationServices/ApplicationServices.h>
#include <CoreFoundation/CoreFoundation.h>
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

static CGPoint current(void) {
  CGEventRef ev = CGEventCreate(NULL);
  CGPoint p = CGEventGetLocation(ev);
  CFRelease(ev);
  return p;
}

static void warp(double x, double y) {
  CGWarpMouseCursorPosition(CGPointMake(x, y));
}

// Virtual keycode for a single key name (US layout). -1 if unknown.
static int keycode_for(const char *n) {
  // letters
  static const char *letters = "abcdefghijklmnopqrstuvwxyz";
  static const int lk[26] = {0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46,
                             45, 31, 35, 12, 15, 1, 17, 32, 9, 13, 7, 16, 6};
  if (strlen(n) == 1) {
    char c = (char)tolower((unsigned char)n[0]);
    const char *p = strchr(letters, c);
    if (p) return lk[p - letters];
    switch (c) {
      case '0': return 29; case '1': return 18; case '2': return 19;
      case '3': return 20; case '4': return 21; case '5': return 23;
      case '6': return 22; case '7': return 26; case '8': return 28;
      case '9': return 25;
      case '-': return 27; case '=': return 24; case ' ': return 49;
      case '.': return 47; case ',': return 43; case '/': return 44;
      case ';': return 41; case '\'': return 39; case '\\': return 42;
      case '[': return 33; case ']': return 30; case '`': return 50;
    }
  }
  if (!strcasecmp(n, "return") || !strcasecmp(n, "enter")) return 36; // main Return
  if (!strcasecmp(n, "keypadenter")) return 76;
  if (!strcasecmp(n, "tab")) return 48;
  if (!strcasecmp(n, "space") || !strcasecmp(n, "spacebar")) return 49;
  if (!strcasecmp(n, "backspace") || !strcasecmp(n, "delete") || !strcasecmp(n, "del")) return 51;
  if (!strcasecmp(n, "forwarddelete")) return 117;
  if (!strcasecmp(n, "escape") || !strcasecmp(n, "esc")) return 53;
  if (!strcasecmp(n, "left")) return 123;
  if (!strcasecmp(n, "right")) return 124;
  if (!strcasecmp(n, "down")) return 125;
  if (!strcasecmp(n, "up")) return 126;
  if (!strcasecmp(n, "home")) return 115;
  if (!strcasecmp(n, "end")) return 119;
  if (!strcasecmp(n, "pageup")) return 116;
  if (!strcasecmp(n, "pagedown")) return 121;
  if (!strcasecmp(n, "f1")) return 122; if (!strcasecmp(n, "f2")) return 120;
  if (!strcasecmp(n, "f3")) return 99;  if (!strcasecmp(n, "f4")) return 118;
  if (!strcasecmp(n, "f5")) return 96;  if (!strcasecmp(n, "f6")) return 97;
  if (!strcasecmp(n, "f7")) return 98;  if (!strcasecmp(n, "f8")) return 100;
  if (!strcasecmp(n, "f9")) return 101; if (!strcasecmp(n, "f10")) return 109;
  if (!strcasecmp(n, "f11")) return 103; if (!strcasecmp(n, "f12")) return 111;
  return -1;
}

// Modifier flag for a name, or 0 if it isn't a modifier.
static CGEventFlags flag_for(const char *n) {
  if (!strcasecmp(n, "cmd") || !strcasecmp(n, "command") || !strcasecmp(n, "meta") ||
      !strcasecmp(n, "win") || !strcasecmp(n, "super"))
    return kCGEventFlagMaskCommand;
  if (!strcasecmp(n, "shift")) return kCGEventFlagMaskShift;
  if (!strcasecmp(n, "ctrl") || !strcasecmp(n, "control")) return kCGEventFlagMaskControl;
  if (!strcasecmp(n, "alt") || !strcasecmp(n, "option") || !strcasecmp(n, "opt"))
    return kCGEventFlagMaskAlternate;
  return 0;
}

static int do_key(const char *combo) {
  // Split on '+': all-but-last are modifiers, last is the key. A chord is
  // represented as the modifier flags set on the final key's keydown event.
  char buf[256];
  strncpy(buf, combo, sizeof(buf) - 1);
  buf[sizeof(buf) - 1] = 0;
  char *tokens[16];
  int n = 0;
  char *tok = strtok(buf, "+");
  while (tok && n < 16) { tokens[n++] = tok; tok = strtok(NULL, "+"); }
  if (n == 0) return 1;

  CGEventFlags flags = 0;
  for (int i = 0; i < n - 1; i++) {
    CGEventFlags f = flag_for(tokens[i]);
    if (!f) { fprintf(stderr, "unknown modifier: %s\n", tokens[i]); return 2; }
    flags |= f;
  }
  const char *last = tokens[n - 1];
  CGEventFlags lastAsMod = flag_for(last);
  int kc = keycode_for(last);
  if (kc < 0) {
    // Allow a bare modifier (e.g. just "cmd"): nothing to tap.
    if (lastAsMod) return 0;
    fprintf(stderr, "unknown key: %s\n", last);
    return 2;
  }
  CGEventRef down = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)kc, true);
  CGEventSetFlags(down, flags);
  CGEventPost(kCGHIDEventTap, down);
  CFRelease(down);
  CGEventRef up = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)kc, false);
  CGEventSetFlags(up, flags);
  CGEventPost(kCGHIDEventTap, up);
  CFRelease(up);
  return 0;
}

static int do_type(const char *text) {
  CFStringRef s = CFStringCreateWithCString(NULL, text, kCFStringEncodingUTF8);
  if (!s) return 2;
  CFIndex len = CFStringGetLength(s);
  for (CFIndex i = 0; i < len; i++) {
    UniChar ch = CFStringGetCharacterAtIndex(s, i);
    CGEventRef down = CGEventCreateKeyboardEvent(NULL, 0, true);
    CGEventKeyboardSetUnicodeString(down, 1, &ch);
    CGEventPost(kCGHIDEventTap, down);
    CFRelease(down);
    CGEventRef up = CGEventCreateKeyboardEvent(NULL, 0, false);
    CGEventKeyboardSetUnicodeString(up, 1, &ch);
    CGEventPost(kCGHIDEventTap, up);
    CFRelease(up);
  }
  CFRelease(s);
  return 0;
}

static int do_click(double x, double y, const char *btn, int dbl) {
  warp(x, y);
  CGPoint pt = CGPointMake(x, y);
  CGEventType downT = kCGEventLeftMouseDown, upT = kCGEventLeftMouseUp;
  CGMouseButton b = kCGMouseButtonLeft;
  if (!strcasecmp(btn, "right")) {
    downT = kCGEventRightMouseDown; upT = kCGEventRightMouseUp; b = kCGMouseButtonRight;
  } else if (!strcasecmp(btn, "middle")) {
    downT = kCGEventOtherMouseDown; upT = kCGEventOtherMouseUp; b = kCGMouseButtonCenter;
  }
  int clicks = dbl ? 2 : 1;
  for (int i = 1; i <= clicks; i++) {
    CGEventRef d = CGEventCreateMouseEvent(NULL, downT, pt, b);
    CGEventSetIntegerValueField(d, kCGMouseEventClickState, i);
    CGEventPost(kCGHIDEventTap, d);
    CFRelease(d);
    CGEventRef u = CGEventCreateMouseEvent(NULL, upT, pt, b);
    CGEventSetIntegerValueField(u, kCGMouseEventClickState, i);
    CGEventPost(kCGHIDEventTap, u);
    CFRelease(u);
  }
  return 0;
}

static int do_drag(double x1, double y1, double x2, double y2) {
  warp(x1, y1);
  CGPoint from = CGPointMake(x1, y1), to = CGPointMake(x2, y2);
  CGEventRef down = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, from, kCGMouseButtonLeft);
  CGEventPost(kCGHIDEventTap, down);
  CFRelease(down);
  CGEventRef dragEv = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDragged, to, kCGMouseButtonLeft);
  CGEventPost(kCGHIDEventTap, dragEv);
  CFRelease(dragEv);
  CGEventRef up = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, to, kCGMouseButtonLeft);
  CGEventPost(kCGHIDEventTap, up);
  CFRelease(up);
  return 0;
}

static int do_scroll(int dx, int dy) {
  CGEventRef e = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 2, dy, dx);
  CGEventPost(kCGHIDEventTap, e);
  CFRelease(e);
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "usage: %s <command> ...\n", argv[0]); return 1; }
  const char *cmd = argv[1];

  if (!strcmp(cmd, "pos")) {
    CGPoint p = current();
    printf("%.0f %.0f\n", p.x, p.y);
    return 0;
  }
  if (!strcmp(cmd, "screen")) {
    CGRect b = CGDisplayBounds(CGMainDisplayID());
    printf("%.0f %.0f\n", b.size.width, b.size.height);
    return 0;
  }
  if (!strcmp(cmd, "move")) {
    if (argc < 4) return 1;
    warp(atof(argv[2]), atof(argv[3]));
    CGPoint p = current();
    printf("%.0f %.0f\n", p.x, p.y);
    return 0;
  }
  if (!strcmp(cmd, "click")) {
    if (argc < 6) return 1;
    return do_click(atof(argv[2]), atof(argv[3]), argv[4], atoi(argv[5]));
  }
  if (!strcmp(cmd, "drag")) {
    if (argc < 6) return 1;
    return do_drag(atof(argv[2]), atof(argv[3]), atof(argv[4]), atof(argv[5]));
  }
  if (!strcmp(cmd, "scroll")) {
    if (argc < 4) return 1;
    return do_scroll(atoi(argv[2]), atoi(argv[3]));
  }
  if (!strcmp(cmd, "type")) {
    if (argc < 3) return 1;
    return do_type(argv[2]);
  }
  if (!strcmp(cmd, "key")) {
    if (argc < 3) return 1;
    return do_key(argv[2]);
  }
  fprintf(stderr, "unknown command: %s\n", cmd);
  return 1;
}
