from app.trades import parse_csv

MT4 = """Ticket\tOpen Time\tType\tSize\tItem\tPrice\tS / L\tT / P\tClose Time\tPrice\tCommission\tTaxes\tSwap\tProfit
1001\t2024.03.01 10:00:00\tbuy\t0.10\txauusd\t2050.00\t2040.00\t2070.00\t2024.03.01 15:00:00\t2060.00\t-0.70\t0.00\t0.00\t100.00
1002\t2024.03.04 09:30:00\tsell\t0.20\txauusd\t2080.50\t0\t0\t2024.03.05 11:00:00\t2085.50\t-1.40\t0.00\t-2.10\t-100.00
1003\t2024.03.04 09:30:00\tbuy\t1.00\teurusd\t1.0850\t0\t0\t2024.03.05 11:00:00\t1.0860\t0\t0\t0\t100.00
1004\t2024.03.06 12:00:00\tbalance\t\t\t\t\t\t\t\t\t\t\t500.00
"""


def signup(client, email="t@example.com"):
    assert client.post("/auth/signup", json={"email": email, "password": "longenough"}).status_code == 201


def test_parse_mt4_history():
    trades, skipped = parse_csv(MT4)
    assert [tk for tk, _ in trades] == ["1001", "1002"]
    a, b = trades[0][1], trades[1][1]
    assert (a.side, a.units, a.open_price, a.close_price, a.stop_loss, a.fees) == ("long", 10, 2050, 2060, 2040, 0.7)
    assert (b.side, b.units, b.swap, b.stop_loss) == ("short", 20, -2.1, None)
    assert len(skipped) == 2 and "not gold" in skipped[0]


def test_parse_simple_spreadsheet_with_ounces():
    text = "side,units,open_time,open_price,close_time,close_price,fees\nlong,5,2024-05-01 10:00,2300,2024-05-02 10:00,2310,1\n"
    trades, skipped = parse_csv(text)
    assert not skipped and trades[0][1].units == 5 and trades[0][1].close_price == 2310


def test_manual_trades_and_report(client):
    signup(client)
    long_ = {"side": "long", "units": 10, "open_time": "2024-03-01T10:00:00Z", "open_price": 2050,
             "close_time": "2024-03-01T15:00:00Z", "close_price": 2060, "fees": 1}
    r = client.post("/trades", json=long_)
    assert r.status_code == 201 and r.json()["pnl"] == 99
    short = {"side": "short", "units": 5, "open_time": "2024-03-02T10:00:00Z", "open_price": 2060,
             "close_time": "2024-03-03T10:00:00Z", "close_price": 2070, "swap": -1.5}
    assert client.post("/trades", json=short).json()["pnl"] == -51.5
    open_trade = {"side": "long", "units": 1, "open_time": "2024-03-04T10:00:00Z", "open_price": 2000}
    assert client.post("/trades", json=open_trade).json()["pnl"] is None

    rep = client.get("/trades/report", params={"capital": 1000}).json()
    s = rep["stats"]
    assert s["trades"] == 2 and s["net_profit"] == 47.5 and s["win_rate_pct"] == 50
    assert s["profit_factor"] == round(99 / 51.5, 2)
    assert [p["equity"] for p in rep["equity"]] == [1000, 1099, 1047.5]

    tid = client.get("/trades").json()[0]["id"]
    assert client.delete(f"/trades/{tid}").status_code == 204
    assert len(client.get("/trades").json()) == 2


def test_trade_validation(client):
    signup(client)
    half_closed = {"side": "long", "units": 1, "open_time": "2024-03-01T10:00:00Z", "open_price": 2000,
                   "close_price": 2010}
    assert client.post("/trades", json=half_closed).status_code == 422
    backwards = {**half_closed, "close_time": "2024-02-01T10:00:00Z"}
    assert client.post("/trades", json=backwards).status_code == 422


def test_import_skips_duplicates_and_is_private(client):
    signup(client)
    files = {"file": ("history.csv", MT4.encode(), "text/csv")}
    r = client.post("/trades/import", files=files).json()
    assert (r["imported"], r["duplicates"], r["skipped_count"]) == (2, 0, 2)
    r = client.post("/trades/import", files=files).json()
    assert (r["imported"], r["duplicates"]) == (0, 2)

    client.cookies.clear()
    signup(client, "other@example.com")
    assert client.get("/trades").json() == []
    assert client.get("/trades/report").json()["stats"]["trades"] == 0
