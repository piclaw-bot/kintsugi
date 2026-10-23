ARG RUNTIME_IMAGE=kintsugi-patched-docker:big-rewrite
FROM ${RUNTIME_IMAGE} AS runtime
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d
COPY --from=runtime /usr/local/bin/docker /usr/local/bin/docker
ARG VERSION=v1
ARG MODE=healthy
ARG EAGERLY_PRELOAD=[]
LABEL eagerly-preload=${EAGERLY_PRELOAD}
WORKDIR /opt/kintsugi-system
COPY .build/test-app.js .build/client.js .build/design-system.css ./
RUN printf '%s' "${VERSION}" > version && printf '%s' "${MODE}" > mode
CMD ["bun", "/opt/kintsugi-system/test-app.js"]
