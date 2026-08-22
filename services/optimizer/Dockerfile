# The MILP solver is a hard dependency: CBC ships with PuLP and HiGHS comes from
# highspy, so the image always has a real solver. If neither is importable the
# service refuses to start rather than returning approximate schedules.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY optimizer ./optimizer

RUN python -c "from optimizer.solvers import available_solvers; assert available_solvers(), 'no MILP solver in image'"

EXPOSE 8000

CMD ["uvicorn", "optimizer.service:app", "--host", "0.0.0.0", "--port", "8000"]
