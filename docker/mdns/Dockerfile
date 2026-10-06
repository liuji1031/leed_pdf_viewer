FROM alpine:3.20
RUN apk add --no-cache avahi-tools iproute2
COPY publish.sh /usr/local/bin/publish.sh
RUN chmod +x /usr/local/bin/publish.sh
CMD ["/usr/local/bin/publish.sh"]
