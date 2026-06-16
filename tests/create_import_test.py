import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "tools" / "create_import.py"
SPEC = importlib.util.spec_from_file_location("create_import", MODULE_PATH)
create_import = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(create_import)


def app_quantity(transactions, ticker):
    quantity = 0.0
    for item in sorted(transactions, key=lambda row: row["date"]):
        if item["ticker"] != ticker:
            continue
        if item["side"] == "sell":
            quantity -= min(item["quantity"], quantity)
        else:
            quantity += item["quantity"]
    return quantity


class BitvavoImportTest(unittest.TestCase):
    def test_excel_rows_parse_supported_transaction_types(self):
        buy = create_import.bitvavo_excel_transaction({
            "datetime": "2026-06-01 02:10:52",
            "type": "Buy",
            "currency": "BTC",
            "details": "0.00079062 63244 EUR -50.13 EUR Completed",
        })
        self.assertEqual(buy["ticker"], "BTC")
        self.assertEqual(buy["side"], "buy")
        self.assertEqual(buy["quantity"], 0.00079062)
        self.assertEqual(buy["price"], 63244.0)

        sell = create_import.bitvavo_excel_transaction({
            "datetime": "2024-01-11 09:56:58",
            "type": "Sell",
            "currency": "OP",
            "details": "-195.2 3.5067 EUR 682.79 EUR Completed",
        })
        self.assertEqual(sell["side"], "sell")
        self.assertEqual(sell["quantity"], 195.2)
        self.assertEqual(sell["price"], 3.5067)

        staking = create_import.bitvavo_excel_transaction({
            "datetime": "2026-05-25 17:11:43",
            "type": "Staking",
            "currency": "TIA",
            "details": "0.00174877 Distributed",
        })
        self.assertEqual(staking["side"], "buy")
        self.assertEqual(staking["price"], 0.0)

        withdrawal = create_import.bitvavo_excel_transaction({
            "datetime": "2021-05-05 15:21:12",
            "type": "Withdrawal",
            "currency": "BTC",
            "details": "-0.00002151 0.0002 BTC Completed",
        })
        self.assertEqual(withdrawal["side"], "sell")
        self.assertEqual(withdrawal["quantity"], 0.00002151)
        self.assertEqual(withdrawal["price"], 0.0)

        deposit = create_import.bitvavo_excel_transaction({
            "datetime": "2022-05-15 15:55:32",
            "type": "Deposit",
            "currency": "ETH",
            "details": "0.00240687 Completed",
        })
        self.assertIsNone(deposit)

    def test_crypto_reconciliation_uses_quantities_not_values(self):
        create_import.CURRENT_CRYPTO_QUANTITIES = {"BTC": 0.02}
        create_import.CURRENT_CRYPTO_PRICES = {"BTC": 70000}
        transactions = [
            {
                "ticker": "BTC",
                "name": "Bitcoin",
                "type": "Crypto",
                "side": "buy",
                "date": "2026-01-01",
                "quantity": 0.01,
                "price": 50000,
                "currentPrice": 70000,
                "source": "Bitvavo Excel",
            }
        ]
        adjustments = create_import.reconcile_crypto_snapshot(transactions)
        combined = [*transactions, *adjustments]
        self.assertAlmostEqual(app_quantity(combined, "BTC"), create_import.CURRENT_CRYPTO_QUANTITIES["BTC"])
        self.assertEqual(
            next(item for item in adjustments if item["ticker"] == "BTC")["price"],
            create_import.CURRENT_CRYPTO_PRICES["BTC"],
        )

    def test_zero_crypto_targets_are_removed(self):
        create_import.CURRENT_CRYPTO_QUANTITIES = {"BTC": 0.1}
        transactions = [
            {"ticker": "ADA", "type": "Crypto"},
            {"ticker": "BTC", "type": "Crypto"},
            {"ticker": "VWCE", "type": "ETF"},
        ]
        cleaned = create_import.remove_zero_crypto_targets(transactions)
        self.assertEqual([item["ticker"] for item in cleaned], ["BTC", "VWCE"])


if __name__ == "__main__":
    unittest.main()
