FROM python:3.12-slim

WORKDIR /app

COPY requirements-runtime.txt requirements.txt
RUN pip install --no-cache-dir -i https://mirrors.cloud.tencent.com/pypi/simple -r requirements.txt

COPY app ./app
COPY config ./config
COPY data ./data

ENV PYTHONIOENCODING=utf-8
EXPOSE 8080

CMD ["uvicorn", "app.api.main:app", "--host", "0.0.0.0", "--port", "8080"]
