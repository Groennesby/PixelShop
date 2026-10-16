#!/usr/bin/env python3
"""
PixelShop — Standalone Desktop Launcher (with Interactive Module Loading Splash)
Designed by Dave Groennesby — https://collabs-photography.com/software
Made in Belgium • Fuse Coding
"""

import os
import sys
import time
import socket
import shutil
import threading
import subprocess
from http.server import HTTPServer, SimpleHTTPRequestHandler

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


class PixelShopHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, format, *args):
        pass


def find_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def show_splash():
    try:
        import tkinter as tk
        from PIL import Image, ImageTk

        root = tk.Tk()
        root.overrideredirect(True)
        w, h = 860, 480
        sw = root.winfo_screenwidth()
        sh = root.winfo_screenheight()
        x = (sw - w) // 2
        y = (sh - h) // 2
        root.geometry(f"{w}x{h}+{x}+{y}")
        root.configure(bg='#0A0A0C')

        canvas = tk.Canvas(root, width=w, height=h, highlightthickness=0, bg='#0A0A0C')
        canvas.pack(fill='both', expand=True)

        splash_path = os.path.join(BASE_DIR, 'Splash_Pixelshop.png')
        if not os.path.exists(splash_path):
            splash_path = os.path.join(BASE_DIR, 'app', 'Splash_Pixelshop.png')

        if os.path.exists(splash_path):
            img = Image.open(splash_path).resize((w, h), Image.Resampling.LANCZOS)
            photo = ImageTk.PhotoImage(img)
            canvas.image = photo
            canvas.create_image(0, 0, anchor='nw', image=photo)

        # Draw progress bar track & module text in the left dark studio area
        bar_x = int(w * 0.055)
        bar_y = int(h * 0.59)
        bar_w = int(w * 0.31)
        bar_h = 7

        stage_lbl = canvas.create_text(
            bar_x, bar_y - 12,
            anchor='sw',
            text='CORE ENGINE',
            fill='#FFE400',
            font=('Sans', 9, 'bold')
        )
        pct_lbl = canvas.create_text(
            bar_x + bar_w, bar_y - 12,
            anchor='se',
            text='0%',
            fill='#FFE400',
            font=('Monospace', 9, 'bold')
        )
        canvas.create_rectangle(
            bar_x, bar_y, bar_x + bar_w, bar_y + bar_h,
            outline='#FFE400', fill='#141418', width=1
        )
        bar_fill = canvas.create_rectangle(
            bar_x, bar_y, bar_x, bar_y + bar_h,
            outline='', fill='#FFE400'
        )
        item_lbl = canvas.create_text(
            bar_x, bar_y + 14,
            anchor='nw',
            text='Loading 16-Bit RGB/LAB Color Management...',
            fill='#D4D4DC',
            font=('Sans', 8)
        )

        # Full-width bottom #FFE400 progress line
        btm_fill = canvas.create_rectangle(
            0, h - 4, 0, h,
            outline='', fill='#FFE400'
        )

        steps = [
            (10, 'CORE ENGINE',      'Loading 16-Bit RGB/LAB Color Management...'),
            (25, 'LAYER COMPOSITOR', 'Initializing Non-Destructive Layer & Linear Light Stack...'),
            (42, 'MATTING ENGINE',   'Loading Select Subject Silhouette & Hair Edge Filter...'),
            (58, 'SKY & HORIZON',    'Loading Select Sky & Atmospheric Gradient Analyzer...'),
            (72, 'BACKGROUND MATTE', 'Binding Select Background Inverse Boundary Solver...'),
            (86, 'STUDIO ACTIONS',   'Compiling 16-Bit High-Frequency Separation Pipeline...'),
            (96, 'RETOUCH BRUSHES',  'Calibrating Spot Healing, Clone Stamp & Liquify Kernel...'),
            (100, 'READY',           'Starting PixelShop Studio Workspace...')
        ]

        state_idx = [0]

        def advance():
            idx = state_idx[0]
            if idx >= len(steps):
                root.destroy()
                return
            pct, stg, desc = steps[idx]
            canvas.itemconfig(stage_lbl, text=stg)
            canvas.itemconfig(pct_lbl, text=f"{pct}%")
            canvas.coords(bar_fill, bar_x, bar_y, bar_x + int(bar_w * (pct / 100.0)), bar_y + bar_h)
            canvas.coords(btm_fill, 0, h - 4, int(w * (pct / 100.0)), h)
            canvas.itemconfig(item_lbl, text=desc)
            state_idx[0] += 1
            root.after(340, advance)

        root.after(80, advance)
        root.mainloop()
        return True
    except Exception:
        return False


def main():
    electron_bin = os.path.join(BASE_DIR, 'electron')
    if sys.platform == 'win32':
        electron_bin = os.path.join(BASE_DIR, 'PixelShop.exe')
    if os.path.exists(electron_bin) and os.access(electron_bin, os.X_OK):
        os.execv(electron_bin, [electron_bin, '--no-sandbox'])
        return

    port = find_free_port()
    server = HTTPServer(('127.0.0.1', port), PixelShopHandler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()

    shown = show_splash()
    suffix = '?nosplash=1' if shown else ''
    url = f"http://127.0.0.1:{port}/app/index.html{suffix}"

    browsers = [
        'google-chrome',
        'chromium-browser',
        'chromium',
        'brave-browser',
        'microsoft-edge'
    ]
    proc = None
    for b in browsers:
        bin_path = shutil.which(b)
        if bin_path:
            proc = subprocess.Popen([
                bin_path,
                f"--app={url}",
                "--window-size=1620,980",
                "--new-window"
            ])
            break

    if not proc:
        import webbrowser
        webbrowser.open(url)
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
    else:
        proc.wait()


if __name__ == '__main__':
    main()
