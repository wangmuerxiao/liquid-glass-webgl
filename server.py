"""Local dev server with Cache-Control: no-store (avoids stale JS/CSS in browser)."""
import http.server
import socketserver

PORT = 8080


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()

    def guess_type(self, path):
        if path.endswith('.webp'):
            return 'image/webp'
        return super().guess_type(path)


if __name__ == '__main__':
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(('', PORT), Handler) as httpd:
        print('Serving http://localhost:%d  (Ctrl+C to stop)' % PORT)
        httpd.serve_forever()
