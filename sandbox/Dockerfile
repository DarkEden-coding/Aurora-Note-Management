FROM python:3.13-slim

COPY runner.py /usr/local/bin/runner.py
COPY check.py /opt/aurora-python/check.py
RUN chmod 0555 /usr/local/bin/runner.py /opt/aurora-python/check.py

CMD ["python3", "/usr/local/bin/runner.py"]
