const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'public');
const port = 8080;

const mimes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
};

http.createServer((req, res) => {
  let url = req.url === '/' ? '/index.html' : req.url;
  let filePath = path.join(root, url);
  
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    const ext = path.extname(filePath);
    const contentType = mimes[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Content-Length': data.length,
    });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`Server running at http://localhost:${port}`);
});
