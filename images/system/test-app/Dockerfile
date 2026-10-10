ARG RUNTIME_IMAGE=kintsugi-patched-docker:big-rewrite
FROM ${RUNTIME_IMAGE} AS runtime
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
COPY --from=runtime /usr/local/bin/docker /usr/local/bin/docker
ARG VERSION=v1
ARG MODE=healthy
ARG EAGERLY_PRELOAD=[]
LABEL eagerly-preload=${EAGERLY_PRELOAD}
WORKDIR /opt/kintsugi-system
COPY .build/test-app.js .build/client.js .build/design-system.css ./
RUN printf '%s' "${VERSION}" > version && printf '%s' "${MODE}" > mode
CMD ["bun", "/opt/kintsugi-system/test-app.js"]
