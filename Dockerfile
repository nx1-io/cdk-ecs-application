FROM nginx:mainline-alpine
RUN rm /etc/nginx/conf.d/*
ADD docker-files/hello.conf /etc/nginx/conf.d/
ADD docker-files/index.html /usr/share/nginx/html/