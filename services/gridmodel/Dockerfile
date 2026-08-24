# pandapower is a hard dependency: without a power-flow engine the service has
# no way to answer a feasibility question, so the image refuses to build rather
# than shipping something that would return a plausible "feasible".
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY gridmodel ./gridmodel

RUN python -c "import pandapower; from gridmodel.powerflow import evaluate"

EXPOSE 8000

CMD ["uvicorn", "gridmodel.service:app", "--host", "0.0.0.0", "--port", "8000"]
