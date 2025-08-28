.PHONY: build up down logs clean test-pdf-json test-json-xml test-pdf-xml

build:
	docker-compose build

up:
	docker-compose up -d

down:
	docker-compose down

logs:
	docker-compose logs -f gateway

clean:
	docker-compose down -v --rmi all

test-pdf-json:
	curl -sS -X POST \
	  -F 'file=@pdf/2508070002.pdf;type=application/pdf' \
	  -H 'Accept: application/json' \
	  http://localhost:8002/process > /tmp/test-output.json

test-json-xml:
	curl -sS -X POST \
	  -F 'file=@pdf/2508070002.json;type=application/json' \
	  -F 'mapping=pt_simon_invoice_v1.json' \
	  -F 'pretty=1' \
	  -H 'Accept: application/xml' \
	  http://localhost:8002/process > /tmp/test-output.xml

test-pdf-xml:
	curl -sS -X POST \
	  -F 'file=@pdf/2508070002.pdf;type=application/pdf' \
	  -F 'mapping=pt_simon_invoice_v1.json' \
	  -F 'pretty=1' \
	  -H 'Accept: application/xml' \
	  http://localhost:8002/process > /tmp/test-output.xml