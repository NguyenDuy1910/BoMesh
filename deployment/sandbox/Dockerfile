# BoMesh agent sandbox: the image behind the `run_shell` tool.
#
# Build:  docker build -t bomesh-sandbox:latest deployment/sandbox
#
# Containers from this image run with no network, as the non-root `sandbox`
# user, with all capabilities dropped (see docker_sandbox.py). Everything the
# agent may need is therefore installed here, at build time.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MPLBACKEND=Agg \
    LANG=C.UTF-8

RUN pip install \
        "pandas>=2.2,<3" \
        "numpy>=2,<3" \
        "openpyxl>=3.1,<4" \
        "xlsxwriter>=3.2,<4" \
        "matplotlib>=3.9,<4" \
        "python-docx>=1.1,<2" \
        "python-pptx>=1,<2" \
        "pypdf>=5,<7" \
        "reportlab>=4.2,<5" \
        "pillow>=11,<13" \
        "tabulate>=0.9,<1"

# uid 1000 owns the files BoMesh copies into the home directory.
RUN useradd --create-home --home-dir /home/sandbox --uid 1000 --shell /bin/bash sandbox

USER sandbox
WORKDIR /home/sandbox
ENV HOME=/home/sandbox

# Build matplotlib's font cache now so the first chart is not slow.
RUN python3 -c "import matplotlib.pyplot"

CMD ["sleep", "infinity"]
