
```shell
curl --location --request POST 'https://lisansws.epdk.gov.tr/epvys-web/rest/sarjIstasyonlariRest/sarjIstasyonlariSorgulaPublic' > sarjIstasyonlariSorgulaPublic.json
```

```shell
curl -X POST https://lisansws.epdk.gov.tr/epvys-web/rest/sarjIstasyonlariRest/sarjIstasyonuSoketleriSorgulaPublic -H "Content-Type: application/json"  -d '{"sarjIstasyonuNo": "ŞRJ/12262"}' > sarjIstasyonuSoketleriSorgulaPublic.json
```

```shell
curl --location 'https://sarjtr.epdk.gov.tr:443/sarjet/api/stations' \
--header 'User-Agent: Dart/3.1 (dart:io)' \
--header 'Accept-Encoding: gzip' \
--header 'Host: sarjtr.epdk.gov.tr' > stations.json
```

```shell
curl --location https://sarjtr.epdk.gov.tr:443/sarjet/api/stations/id/14551821/2024-06-28%2012:32:16 \
--header 'User-Agent: Dart/3.1 (dart:io)' \
--header 'Accept-Encoding: gzip' \
--header 'Host: sarjtr.epdk.gov.tr' > station-2024.json
```

```shell
curl --location https://sarjtr.epdk.gov.tr:443/sarjet/api/stations/id/14551821/2014-06-28%2012:32:16 \
--header 'User-Agent: Dart/3.1 (dart:io)' \
--header 'Accept-Encoding: gzip' \
--header 'Host: sarjtr.epdk.gov.tr' > station-2014.json
```

```shell
curl --location https://sarjtr.epdk.gov.tr:443/sarjet/api/stations/id/14551821/2025-04-15%2000:00:00 \
--header 'User-Agent: Dart/3.1 (dart:io)' \
--header 'Accept-Encoding: gzip' \
--header 'Host: sarjtr.epdk.gov.tr' > station-2025.json
```
