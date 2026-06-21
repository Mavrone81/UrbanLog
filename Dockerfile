# Static "Urban Werkz Delivery" site served by nginx.
# Sits behind the host nginx reverse proxy at urbanfleetsg.com.
FROM nginx:alpine

# Copy only the site assets into the web root (deploy/meta files are excluded via .dockerignore).
COPY index.html /usr/share/nginx/html/index.html
COPY css/ /usr/share/nginx/html/css/
COPY js/  /usr/share/nginx/html/js/

EXPOSE 80

# nginx:alpine already runs `nginx -g 'daemon off;'` as its default CMD.
