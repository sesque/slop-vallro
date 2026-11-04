"""Static server for register.html that also accepts POST /save (the clicked pairs) into the file named by argv[2]."""
import http.server, sys
out = sys.argv[2]
class H(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0)); open(out + '.' + self.path.split('dir=')[-1], 'wb').write(self.rfile.read(n))
        self.send_response(200); self.end_headers()
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store'); super().end_headers()
http.server.test(HandlerClass=H, port=int(sys.argv[1]))
