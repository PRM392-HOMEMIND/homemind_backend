ARG GO_IMAGE=golang:1.27-trixie@sha256:2f84bc93ecfb2689f782b153fdcd368b5a7ab96c1386c65cdaccf35e726d6a44
ARG POSTGRES_IMAGE=postgres:18-trixie@sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722
FROM ${GO_IMAGE} AS gosu-build
WORKDIR /src
ADD --checksum=sha256:33d7537d588ea49458b9509bcf4554bdf5ceacc66da71e5caa1058ea3b689c3b https://codeload.github.com/tianon/gosu/tar.gz/6456aaa0f3c854d199d0f037f068eb97515b7513 /tmp/gosu.tar.gz
RUN tar -xzf /tmp/gosu.tar.gz --strip-components=1 \
    && CGO_ENABLED=0 GOTOOLCHAIN=local go build -trimpath -ldflags '-s -w -X main.version=1.19' -o /out/gosu .

FROM ${POSTGRES_IMAGE} AS patched
# Keep the official entrypoint/privilege drop; patch OS and the gosu Go runtime.
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/ssl/private/ssl-cert-snakeoil.key /etc/ssl/certs/ssl-cert-snakeoil.pem
COPY --from=gosu-build /out/gosu /usr/local/bin/gosu
RUN gosu postgres id -u | grep -v '^0$'

# Export only the sanitized filesystem. The upstream shared snakeoil private key
# must also be absent from historical image layers, not merely whiteouted.
FROM scratch
COPY --from=patched / /
ARG RELEASE_SHA=development
LABEL org.opencontainers.image.source="https://github.com/PRM392-HOMEMIND/homemind_backend" org.opencontainers.image.revision="${RELEASE_SHA}"
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/lib/postgresql/18/bin \
    GOSU_VERSION=1.19 LANG=en_US.utf8 PG_MAJOR=18 PG_VERSION=18.6-1.pgdg13+2 \
    PGDATA=/var/lib/postgresql/18/docker
VOLUME /var/lib/postgresql
ENTRYPOINT ["docker-entrypoint.sh"]
STOPSIGNAL SIGINT
EXPOSE 5432
CMD ["postgres"]
