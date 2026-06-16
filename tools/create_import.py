import argparse
import json
import csv
import re
import uuid
import zipfile
import zlib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from xml.etree import ElementTree as ET


SOURCE_DIR = Path("source")
OUT = Path("portfolio-import.json")
REPORT_OUT = Path("portfolio-import-report.json")
DEGIRO_CSV = Path("source/Account.csv")
BITVAVO_CSV = Path("source/Bitvavo_transacties_analyseklaar.csv")
BITVAVO_XLSX = Path("source/bitvavo-transactions.xlsx")


CURRENT_CRYPTO_PRICES = {}

CURRENT_CRYPTO_QUANTITIES = {}

CRYPTO_SNAPSHOT_DATE = ""
UUID_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "portfolio-tracker-import")


DEGIRO_POSITIONS = []

FALLBACK_DEGIRO_AVG_PRICES = {}

PRODUCT_TICKERS = {
    "ADAGIO MEDICAL HOLDINGS INC": "ADGM",
    "ALLURION TECHNOLOGIES INC": "ALUR",
    "ALPHABET INC CLASS A": "GOOGL",
    "AMC ENTERTAINMENT HOLDINGS INC": "AMC",
    "APPLE INC": "AAPL",
    "ARYA SCIENCES ACQUISITION III CORP": "NAUT",
    "ARYA SCIENCES ACQUISITION IV CORP": "ADGM",
    "CHURCHILL CAPITAL IV CORP": "LCID",
    "COMPUTE HEALTH ACQUISITION CORP.": "ALUR",
    "CONX CORP": "CONX",
    "IONQ INC": "IONQ",
    "ISHARES STOXX GLOBAL SELECT DIVIDEND": "ISPA",
    "LUCID GROUP INC": "LCID",
    "MORGAN STANLEY EUR LIQUIDITY FUND": "MSEUR",
    "NAUTILUS BIOTECHNOLOGY INC": "NAUT",
    "ROCKET LAB CORP": "RKLB",
    "ROCKET LAB USA INC": "RKLB",
    "TESLA INC": "TSLA",
    "TPG PACE BENEFICIAL FIN-CL A": "TPGY",
    "TPG PACE BENEFICIAL FINANCE CORP.": "TPGY",
    "VANGUARD FTSE ALL-WORLD UCITS - (USD)": "VWCE",
    "VANGUARD FTSE ALL-WORLD UCITS ETF": "VWRL",
    "VECTOR ACQUISITION CORP": "RKLB",
    "WISDOMTREE ARTIFICIAL INTELL UCITS ETF": "WTAI",
}

PRODUCT_NAMES = {
    ticker: name
    for ticker, name, _kind, _quantity, _value in DEGIRO_POSITIONS
}
PRODUCT_NAMES.update({
    "ALUR": "Allurion Technologies Inc",
    "AMC": "AMC Entertainment Holdings Inc",
    "AAPL": "Apple Inc",
    "LCID": "Lucid Group Inc",
    "ISPA": "iShares STOXX Global Select Dividend",
    "MSEUR": "Morgan Stanley EUR Liquidity Fund",
    "TPGY": "TPG Pace Beneficial Finance Corp.",
    "VWRL": "Vanguard FTSE All-World UCITS ETF",
    "WTAI": "WisdomTree Artificial Intelligence UCITS ETF",
})

PRODUCT_TYPES = {
    "VWCE": "ETF",
    "VWRL": "ETF",
    "ISPA": "ETF",
    "WTAI": "ETF",
    "MSEUR": "ETF",
}


def parse_number(value):
    return float(value.replace(" EUR", "").replace(",", ".").replace("−", "-").strip())


def parse_decimal(value):
    return float(value.replace(".", "").replace(",", ".").strip())


def parse_money(value):
    if not value:
        return 0.0
    cleaned = value.replace(" EUR", "").replace("USD", "").replace(",", ".").replace("−", "-").strip()
    return float(cleaned)


def stable_id(*parts):
    normalized = "|".join(str(part) for part in parts)
    return str(uuid.uuid5(UUID_NAMESPACE, normalized))


def required_columns(reader, required, label):
    missing = [column for column in required if column not in (reader.fieldnames or [])]
    if missing:
        raise ValueError(f"{label} mist verplichte kolommen: {', '.join(missing)}")


def read_xlsx_rows(path, sheet_name):
    ns = {
        "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
        "rel": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
        "pkg_rel": "http://schemas.openxmlformats.org/package/2006/relationships",
    }
    with zipfile.ZipFile(path) as archive:
        shared_strings = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            for item in root.findall("main:si", ns):
                shared_strings.append("".join(text.text or "" for text in item.findall(".//main:t", ns)))

        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        rel_targets = {
            rel.attrib["Id"]: rel.attrib["Target"]
            for rel in rels.findall("pkg_rel:Relationship", ns)
        }
        sheet_target = None
        for sheet in workbook.findall("main:sheets/main:sheet", ns):
            if sheet.attrib.get("name") == sheet_name:
                sheet_target = rel_targets[sheet.attrib[f"{{{ns['rel']}}}id"]]
                break
        if not sheet_target:
            raise ValueError(f"Excelbestand mist sheet: {sheet_name}")

        sheet_path = sheet_target.lstrip("/")
        if not sheet_path.startswith("xl/"):
            sheet_path = f"xl/{sheet_path}"
        sheet_root = ET.fromstring(archive.read(sheet_path))
        rows = []
        for row in sheet_root.findall(".//main:sheetData/main:row", ns):
            values = []
            for cell in row.findall("main:c", ns):
                value = cell.find("main:v", ns)
                inline = cell.find("main:is/main:t", ns)
                raw = inline.text if inline is not None else value.text if value is not None else ""
                if cell.attrib.get("t") == "s" and raw != "":
                    raw = shared_strings[int(raw)]
                values.append(raw)
            rows.append(values)

    if not rows:
        return []
    headers = [str(value).strip() for value in rows[0]]
    return [
        {headers[index]: row[index] if index < len(row) else "" for index in range(len(headers))}
        for row in rows[1:]
        if any(str(value).strip() for value in row)
    ]


def excel_datetime(value):
    text = str(value).strip()
    if re.match(r"^\d{4}-\d{2}-\d{2}", text):
        return text[:10]
    try:
        serial = float(text)
    except ValueError:
        return text[:10]
    return (datetime(1899, 12, 30) + timedelta(days=serial)).date().isoformat()


def bitvavo_excel_transaction(row):
    kind = str(row.get("type", "")).strip()
    ticker = str(row.get("currency", "")).upper().strip()
    details = str(row.get("details", "")).strip()
    if ticker == "EUR" or kind == "Deposit":
        return None
    if kind not in {"Buy", "Sell", "Staking", "Withdrawal"}:
        return None

    numbers = re.findall(r"-?\d+(?:\.\d+)?", details)
    if not numbers:
        return None
    quantity = abs(float(numbers[0]))
    if quantity <= 0:
        return None

    if kind in {"Staking", "Withdrawal"}:
        price = 0.0
    else:
        price = float(numbers[1]) if len(numbers) > 1 else 0.0
    side = "sell" if kind in {"Sell", "Withdrawal"} else "buy"
    date = excel_datetime(row.get("datetime", ""))
    current_price = CURRENT_CRYPTO_PRICES.get(ticker, price)
    return {
        "id": stable_id("Bitvavo Excel", row.get("datetime", ""), kind, ticker, quantity, price),
        "ticker": ticker,
        "name": crypto_name(ticker),
        "type": "Crypto",
        "side": side,
        "date": date,
        "quantity": quantity,
        "price": price,
        "currentPrice": current_price,
        "auto": False,
        "dcaId": None,
        "source": "Bitvavo Excel",
    }


def pdf_strings(path):
    data = path.read_bytes()
    strings = []

    def unescape(value):
        result = []
        i = 0
        while i < len(value):
            char = value[i]
            if char == "\\" and i + 1 < len(value):
                i += 1
                result.append({"n": "\n", "r": "\r", "t": "\t", "b": "\b", "f": "\f"}.get(value[i], value[i]))
            else:
                result.append(char)
            i += 1
        return "".join(result)

    for match in re.finditer(rb"stream\r?\n(.*?)\r?\nendstream", data, re.S):
        try:
            stream = zlib.decompress(match.group(1)).decode("latin1", "ignore")
        except Exception:
            continue
        for text_match in re.finditer(r"\((?:\\.|[^\\)])*\)\s*Tj", stream):
            raw = text_match.group(0)[1:text_match.group(0).rfind(")")]
            strings.append(unescape(raw))
    return strings


def bitvavo_transactions():
    if BITVAVO_CSV.exists():
        return bitvavo_csv_transactions()
    if BITVAVO_XLSX.exists():
        return bitvavo_excel_transactions()

    pdf_path = SOURCE_DIR / "Volledige geschiedenis.pdf"
    if not pdf_path.exists():
        return []

    strings = pdf_strings(pdf_path)
    date_indexes = [i for i, value in enumerate(strings) if re.match(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$", value)]
    transactions = []

    for pos, start in enumerate(date_indexes):
        end = date_indexes[pos + 1] if pos + 1 < len(date_indexes) else len(strings)
        row = strings[start:end]
        if len(row) < 5:
            continue

        date_time, kind = row[0], row[1]
        if kind not in {"Buy", "Sell", "Staking", "Withdrawal", "Fixed_staking", "Manually_assi"}:
            continue

        if kind == "Manually_assi":
            offset = 1 if len(row) > 3 and row[2] == "gned" else 0
            ticker = row[2 + offset].upper()
            if ticker == "EUR":
                continue
            quantity = abs(parse_number(row[3 + offset]))
        else:
            ticker = row[2].upper()
            quantity = abs(parse_number(row[3]))

        if kind in {"Staking", "Fixed_staking", "Manually_assi", "Withdrawal"}:
            price = 0.0
            side = "sell" if kind == "Withdrawal" else "buy"
        else:
            price = parse_number(row[4])
            side = "buy" if kind == "Buy" else "sell"

        current_price = CURRENT_CRYPTO_PRICES.get(ticker, price)
        transactions.append({
            "id": stable_id("Bitvavo PDF", date_time[:10], kind, ticker, quantity, price),
            "ticker": ticker,
            "name": crypto_name(ticker),
            "type": "Crypto",
            "side": side,
            "date": date_time[:10],
            "quantity": quantity,
            "price": price,
            "currentPrice": current_price,
            "auto": False,
            "dcaId": None,
            "source": "Bitvavo PDF",
        })

    return transactions


def bitvavo_excel_transactions():
    required = {"datetime", "type", "currency", "details"}
    rows = read_xlsx_rows(BITVAVO_XLSX, "Transacties")
    missing = required - set(rows[0].keys() if rows else [])
    if missing:
        raise ValueError(f"Bitvavo Excel mist verplichte kolommen: {', '.join(sorted(missing))}")
    transactions = []
    for row in rows:
        transaction = bitvavo_excel_transaction(row)
        if transaction:
            transactions.append(transaction)
    return transactions


def bitvavo_csv_transactions():
    transactions = []
    with BITVAVO_CSV.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        required_columns(reader, ["Type", "Coin", "Aantal", "Koers", "Datum/tijd"], "Bitvavo CSV")
        for row in reader:
            kind = row["Type"]
            ticker = row["Coin"].upper()
            if ticker == "EUR" or kind == "Deposit":
                continue
            if kind not in {"Buy", "Sell", "Staking", "Withdrawal", "Fixed_staking", "Manually_assigned"}:
                continue

            quantity = abs(parse_money(row["Aantal"]))
            if quantity <= 0:
                continue

            if kind in {"Staking", "Fixed_staking", "Manually_assigned", "Withdrawal"}:
                price = 0.0
                side = "sell" if kind == "Withdrawal" else "buy"
            else:
                price = parse_money(row["Koers"])
                side = "buy" if kind == "Buy" else "sell"

            current_price = CURRENT_CRYPTO_PRICES.get(ticker, price)
            transactions.append({
                "id": stable_id("Bitvavo CSV", row["Datum/tijd"], kind, ticker, quantity, price),
                "ticker": ticker,
                "name": crypto_name(ticker),
                "type": "Crypto",
                "side": side,
                "date": row["Datum/tijd"][:10],
                "quantity": quantity,
                "price": price,
                "currentPrice": current_price,
                "auto": False,
                "dcaId": None,
                "source": "Bitvavo CSV",
            })

    return transactions


def crypto_name(ticker):
    names = {
        "BTC": "Bitcoin",
        "ETH": "Ethereum",
        "SOL": "Solana",
        "ZK": "zkSync",
        "OP": "Optimism",
        "TIA": "Celestia",
        "ADA": "Cardano",
        "DOGE": "Dogecoin",
        "LINK": "Chainlink",
    }
    return names.get(ticker, ticker)


def degiro_snapshot_transactions():
    date = "1970-01-01"
    rows = []
    for ticker, name, kind, quantity, value in DEGIRO_POSITIONS:
        price = value / quantity
        rows.append({
            "id": stable_id("DEGIRO screenshot snapshot", date, ticker, quantity, price),
            "ticker": ticker,
            "name": name,
            "type": kind,
            "side": "buy",
            "date": date,
            "quantity": quantity,
            "price": price,
            "currentPrice": price,
            "auto": False,
            "dcaId": None,
            "source": "DEGIRO screenshot snapshot",
        })
    return rows


def degiro_rows():
    if not DEGIRO_CSV.exists():
        return []

    with DEGIRO_CSV.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.reader(handle)
        next(reader, None)
        raw_rows = [row for row in reader if any(value.strip() for value in row)]
        short_rows = [index + 2 for index, row in enumerate(raw_rows) if len(row) < 12]
        if short_rows:
            raise ValueError(f"DEGIRO CSV bevat onvolledige rijen: {short_rows[:10]}")
        return raw_rows


def degiro_order_groups(rows):
    rows_by_order = {}
    for row in rows:
        if row[11]:
            rows_by_order.setdefault(row[11], []).append(row)

    groups = {}
    no_order_counter = 0
    for row in rows:
        description = row[5]
        if not re.search(r"(Koop|Verkoop)\s+[0-9.,]+\s+@", description):
            continue
        order_id = row[11] or f"no-order-{no_order_counter}"
        if not row[11]:
            no_order_counter += 1
        groups[order_id] = rows_by_order.get(row[11], [row]) if row[11] else [row]
    return groups


def degiro_order_transactions():
    rows = degiro_rows()
    groups = degiro_order_groups(rows)
    transactions = []
    seen_orders = set()

    current_prices = {
        ticker: value / quantity
        for ticker, _name, _kind, quantity, value in DEGIRO_POSITIONS
    }

    for order_id, order_rows in groups.items():
        if order_id in seen_orders:
            continue
        seen_orders.add(order_id)
        trade_rows = [row for row in order_rows if re.search(r"(Koop|Verkoop)\s+[0-9.,]+\s+@", row[5])]
        if not trade_rows:
            continue

        sample = trade_rows[0]
        ticker = PRODUCT_TICKERS.get(sample[3])
        if not ticker:
            continue

        side = "buy" if "Koop" in sample[5] else "sell"
        quantity = 0.0
        trade_currency = "EUR"
        trade_notional = 0.0
        trade_price = 0.0

        for trade in trade_rows:
            match = re.search(r"(Koop|Verkoop)\s+([0-9.,]+)\s+@\s+([0-9.,]+)\s+([A-Z]{3})", trade[5])
            if not match:
                continue
            qty = parse_decimal(match.group(2))
            price = parse_decimal(match.group(3))
            trade_currency = match.group(4)
            quantity += qty
            trade_notional += qty * price
            trade_price = price

        if quantity <= 0:
            continue

        eur_cash = 0.0
        fees = 0.0
        for row in order_rows:
            if row[7] != "EUR":
                continue
            amount = parse_decimal(row[8]) if row[8] else 0.0
            if "Transactiekosten" in row[5]:
                fees += abs(amount)
            elif row[5].startswith("Valuta Debitering") or row[5].startswith("Valuta Creditering"):
                eur_cash += abs(amount)
            elif re.search(r"(Koop|Verkoop)\s+[0-9.,]+\s+@", row[5]) and trade_currency == "EUR":
                eur_cash += abs(amount)

        if eur_cash <= 0:
            eur_cash = trade_notional
        unit_price = (eur_cash + fees) / quantity if side == "buy" else eur_cash / quantity
        if unit_price <= 0:
            unit_price = trade_price

        date = f"{sample[0][6:10]}-{sample[0][3:5]}-{sample[0][0:2]}"
        transactions.append({
            "id": stable_id("DEGIRO Account.csv", order_id, date, ticker, side, quantity, unit_price),
            "ticker": ticker,
            "name": PRODUCT_NAMES.get(ticker, sample[3].title()),
            "type": PRODUCT_TYPES.get(ticker, "Aandeel"),
            "side": side,
            "date": date,
            "quantity": quantity,
            "price": unit_price,
            "currentPrice": current_prices.get(ticker, unit_price),
            "auto": False,
            "dcaId": None,
            "source": "DEGIRO Account.csv",
        })

    return transactions


def reconcile_degiro_snapshot(transactions):
    current_prices = {
        ticker: value / quantity
        for ticker, _name, _kind, quantity, value in DEGIRO_POSITIONS
    }
    targets = {
        ticker: {
            "ticker": ticker,
            "name": name,
            "type": kind,
            "quantity": quantity,
            "price": current_prices[ticker],
        }
        for ticker, name, kind, quantity, _value in DEGIRO_POSITIONS
    }
    quantities = {}
    for row in sorted(transactions, key=lambda item: item["date"]):
        current = quantities.get(row["ticker"], 0.0)
        if row["side"] == "sell":
            quantities[row["ticker"]] = current - min(row["quantity"], current)
        else:
            quantities[row["ticker"]] = current + row["quantity"]

    adjustments = []
    adjustment_date = "1970-01-01"
    for ticker in sorted(set(quantities) | set(targets)):
        current_quantity = quantities.get(ticker, 0.0)
        target = targets.get(ticker)
        target_quantity = target["quantity"] if target else 0.0
        difference = target_quantity - current_quantity
        if abs(difference) < 1e-8:
            continue
        price = target["price"] if target else current_prices.get(ticker, 0.0)
        if price <= 0:
            price = next((row["currentPrice"] for row in transactions if row["ticker"] == ticker and row["currentPrice"] > 0), 0.0)
        adjustments.append({
            "id": stable_id("DEGIRO positiecorrectie", adjustment_date, ticker, difference, price),
            "ticker": ticker,
            "name": target["name"] if target else PRODUCT_NAMES.get(ticker, ticker),
            "type": target["type"] if target else PRODUCT_TYPES.get(ticker, "Aandeel"),
            "side": "buy" if difference > 0 else "sell",
            "date": adjustment_date,
            "quantity": abs(difference),
            "price": price,
            "currentPrice": price,
            "auto": False,
            "dcaId": None,
            "source": "DEGIRO positiecorrectie",
        })
    return adjustments


def degiro_average_prices():
    rows = degiro_rows()
    if not rows:
        return {}

    groups = degiro_order_groups(rows)

    transactions = []
    seen_orders = set()
    for order_id, order_rows in groups.items():
        if order_id in seen_orders:
            continue
        seen_orders.add(order_id)
        trade_rows = [row for row in order_rows if re.search(r"(Koop|Verkoop)\s+[0-9.,]+\s+@", row[5])]
        if not trade_rows:
            continue

        sample = trade_rows[0]
        product = sample[3]
        ticker = PRODUCT_TICKERS.get(product)
        if not ticker:
            continue

        side = "buy" if "Koop" in sample[5] else "sell"
        quantity = 0.0
        trade_currency = "EUR"
        trade_notional = 0.0
        for trade in trade_rows:
            match = re.search(r"(Koop|Verkoop)\s+([0-9.,]+)\s+@\s+([0-9.,]+)\s+([A-Z]{3})", trade[5])
            if not match:
                continue
            qty = parse_decimal(match.group(2))
            price = parse_decimal(match.group(3))
            trade_currency = match.group(4)
            quantity += qty
            trade_notional += qty * price

        if quantity <= 0:
            continue

        eur_cash = 0.0
        fees = 0.0
        for row in order_rows:
            if row[7] != "EUR":
                continue
            amount = parse_decimal(row[8]) if row[8] else 0.0
            if "Transactiekosten" in row[5]:
                fees += abs(amount)
            elif row[5].startswith("Valuta Debitering") or row[5].startswith("Valuta Creditering"):
                eur_cash += abs(amount)
            elif re.search(r"(Koop|Verkoop)\s+[0-9.,]+\s+@", row[5]) and trade_currency == "EUR":
                eur_cash += abs(amount)

        if eur_cash <= 0:
            eur_cash = trade_notional
        unit_price = (eur_cash + fees) / quantity
        transactions.append({
            "date": f"{sample[0][6:10]}-{sample[0][3:5]}-{sample[0][0:2]}",
            "ticker": ticker,
            "side": side,
            "quantity": quantity,
            "unit_price": unit_price,
        })

    splits = {}
    for row in rows:
        if "STOCK SPLIT:" not in row[5]:
            continue
        ticker = PRODUCT_TICKERS.get(row[3])
        if not ticker:
            continue
        match = re.search(r"STOCK SPLIT:\s+([0-9.,]+)", row[5])
        if not match:
            continue
        key = (f"{row[0][6:10]}-{row[0][3:5]}-{row[0][0:2]}", ticker)
        splits.setdefault(key, []).append(parse_decimal(match.group(1)))
    for (date, ticker), quantities in splits.items():
        if len(quantities) < 2:
            continue
        small = min(quantities)
        large = max(quantities)
        if small > 0 and large > small:
            transactions.append({
                "date": date,
                "ticker": ticker,
                "side": "split",
                "quantity": large / small,
                "unit_price": 0.0,
            })

    lots = {}
    for item in sorted(transactions, key=lambda tx_item: tx_item["date"]):
        lot = lots.setdefault(item["ticker"], {"quantity": 0.0, "cost": 0.0})
        if item["side"] == "split":
            lot["quantity"] *= item["quantity"]
        elif item["side"] == "sell":
            sold = min(item["quantity"], lot["quantity"])
            avg = lot["cost"] / lot["quantity"] if lot["quantity"] else 0.0
            lot["quantity"] -= sold
            lot["cost"] -= sold * avg
        else:
            lot["quantity"] += item["quantity"]
            lot["cost"] += item["quantity"] * item["unit_price"]

    return {
        ticker: values["cost"] / values["quantity"]
        for ticker, values in lots.items()
        if values["quantity"] > 1e-8 and values["cost"] > 0
    }


def reconcile_crypto_snapshot(transactions):
    quantities = {}
    for row in sorted(transactions, key=lambda item: item["date"]):
        if row["type"] != "Crypto":
            continue
        current = quantities.get(row["ticker"], 0.0)
        if row["side"] == "sell":
            quantities[row["ticker"]] = current - min(row["quantity"], current)
        else:
            quantities[row["ticker"]] = current + row["quantity"]

    adjustments = []

    for ticker, target_quantity in CURRENT_CRYPTO_QUANTITIES.items():
        price = CURRENT_CRYPTO_PRICES.get(ticker, 0.0)
        current_quantity = quantities.get(ticker, 0.0)
        difference = target_quantity - current_quantity
        if abs(difference) < 1e-8:
            continue
        adjustments.append({
            "id": stable_id("Crypto screenshot reconciliation", CRYPTO_SNAPSHOT_DATE, ticker, difference, price),
            "ticker": ticker,
            "name": crypto_name(ticker),
            "type": "Crypto",
            "side": "buy" if difference > 0 else "sell",
            "date": CRYPTO_SNAPSHOT_DATE,
            "quantity": abs(difference),
            "price": price,
            "currentPrice": price,
            "auto": False,
            "dcaId": None,
            "source": "Crypto screenshot reconciliation",
        })
    return adjustments


def remove_zero_crypto_targets(transactions):
    open_crypto = set(CURRENT_CRYPTO_QUANTITIES)
    return [
        row
        for row in transactions
        if row.get("type") != "Crypto" or row.get("ticker") in open_crypto
    ]


def parse_args():
    parser = argparse.ArgumentParser(description="Maak een portfolio-importbestand uit brokerexports.")
    parser.add_argument("--source-dir", type=Path, default=SOURCE_DIR, help="Map met aanvullende bronbestanden, zoals de Bitvavo PDF.")
    parser.add_argument("--degiro-csv", type=Path, default=DEGIRO_CSV, help="Pad naar DEGIRO Account.csv.")
    parser.add_argument("--bitvavo-csv", type=Path, default=BITVAVO_CSV, help="Pad naar Bitvavo CSV-export.")
    parser.add_argument("--bitvavo-xlsx", type=Path, default=BITVAVO_XLSX, help="Pad naar Bitvavo Excel-export.")
    parser.add_argument("--out", type=Path, default=OUT, help="Doelbestand voor de portfolio-import JSON.")
    parser.add_argument("--report-out", type=Path, default=REPORT_OUT, help="Doelbestand voor het import rapport.")
    parser.add_argument("--source-version", default="local-broker-import", help="Herkenbare versie/bronlabel voor de import.")
    return parser.parse_args()


def write_report(path, payload, counts, warnings):
    report = {
        "generatedAt": payload["meta"]["generatedAt"],
        "output": str(OUT),
        "counts": counts,
        "warnings": warnings,
        "sources": {
            "sourceDir": str(SOURCE_DIR),
            "degiroCsv": str(DEGIRO_CSV),
            "bitvavoCsv": str(BITVAVO_CSV),
            "bitvavoXlsx": str(BITVAVO_XLSX),
        },
    }
    path.write_text(json.dumps(report, indent=2), encoding="utf-8")


def main(args=None):
    global SOURCE_DIR, OUT, REPORT_OUT, DEGIRO_CSV, BITVAVO_CSV, BITVAVO_XLSX

    options = args or parse_args()
    SOURCE_DIR = options.source_dir
    OUT = options.out
    REPORT_OUT = options.report_out
    DEGIRO_CSV = options.degiro_csv
    BITVAVO_CSV = options.bitvavo_csv
    BITVAVO_XLSX = options.bitvavo_xlsx

    warnings = []
    if not BITVAVO_CSV.exists() and not BITVAVO_XLSX.exists() and not (SOURCE_DIR / "Volledige geschiedenis.pdf").exists():
        warnings.append("Geen Bitvavo CSV, Excel of PDF gevonden; Bitvavo-transacties zijn overgeslagen.")
    if not DEGIRO_CSV.exists():
        warnings.append("Geen DEGIRO CSV gevonden; alleen snapshotcorrecties worden gebruikt.")

    bitvavo = remove_zero_crypto_targets(bitvavo_transactions())
    crypto_adjustments = reconcile_crypto_snapshot(bitvavo)
    degiro = degiro_order_transactions()
    degiro_adjustments = reconcile_degiro_snapshot(degiro)
    degiro_avg_prices = {**FALLBACK_DEGIRO_AVG_PRICES, **degiro_average_prices()}
    prices = {ticker: price for ticker, price in CURRENT_CRYPTO_PRICES.items()}
    for ticker, _name, _kind, quantity, value in DEGIRO_POSITIONS:
        prices[ticker] = value / quantity
    for row in degiro:
        prices.setdefault(row["ticker"], row["currentPrice"])
    generated_at = datetime.now(timezone.utc).isoformat()

    payload = {
        "meta": {
            "sourceVersion": options.source_version,
            "generatedAt": generated_at,
            "lastImportAt": generated_at,
            "lastImportFile": "portfolio-import.json",
        },
        "settings": {
            "defaultHideSmallPositions": True,
            "defaultHideSmallTransactions": False
        },
        "avgPrices": degiro_avg_prices,
        "prices": prices,
        "priceMeta": {
            ticker: {
                "source": "Import snapshot",
                "updatedAt": generated_at,
            }
            for ticker in prices
        },
        "transactions": sorted([*bitvavo, *crypto_adjustments, *degiro, *degiro_adjustments], key=lambda item: item["date"], reverse=True),
        "dcas": [],
        "purchasePlans": [],
        "processedMonths": [],
        "ui": {
            "positionSearch": "",
            "positionSort": "value",
            "positionDir": "desc",
            "hideSmallPositions": True,
            "hideSmallTransactions": False,
            "transactionSearch": "",
            "transactionTypeFilter": "all",
            "transactionSideFilter": "all",
            "transactionLimit": "100",
            "transactionGroup": "month",
            "transactionSpecialFilter": "all"
        },
        "chartRange": 60,
        "notes": [
            "Brokertransacties komen uit lokale exportbestanden in de genegeerde source-map.",
            "Snapshotcorrecties zijn leeg totdat je lokaal eigen waarden invult of importeert.",
            "Gegenereerde importbestanden blijven lokaal en staan in .gitignore.",
        ],
    }
    OUT.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    counts = {
        "transactions": len(payload["transactions"]),
        "bitvavo": len(bitvavo),
        "cryptoAdjustments": len(crypto_adjustments),
        "degiro": len(degiro),
        "degiroAdjustments": len(degiro_adjustments),
        "prices": len(prices),
        "avgPrices": len(degiro_avg_prices),
    }
    write_report(REPORT_OUT, payload, counts, warnings)
    print(f"Wrote {OUT} with {counts['transactions']} transactions ({counts['bitvavo']} Bitvavo, {counts['cryptoAdjustments']} crypto adjustments, {counts['degiro']} DEGIRO Account.csv, {counts['degiroAdjustments']} DEGIRO adjustments).")
    print(f"Wrote {REPORT_OUT} with {len(warnings)} warnings.")


if __name__ == "__main__":
    main()
