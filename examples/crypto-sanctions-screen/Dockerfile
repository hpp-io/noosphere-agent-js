FROM python:3.11-slim

RUN pip install --no-cache-dir fastapi uvicorn

WORKDIR /srv
COPY parse_ofac.py .

# Bake the OFAC SDN sanctioned-address list into the image at build time
# (downloads + parses the authoritative advanced XML, writes a ~150KB data.json,
# then discards the 125MB source). No network needed at runtime.
RUN python parse_ofac.py && rm parse_ofac.py

COPY app.py .

EXPOSE 8095
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8095"]
