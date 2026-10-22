"""Tests for the file viewers' RPCs (filetools.py, agent >= 0.108.0, §14.112).

What is worth pinning:

  * byte ranges: a negative offset is the tail, every read is capped;
  * SQLite is READ-ONLY in every way — writes, ATTACH, transactions and
    writing pragmas are refused, one statement per call, cells are bounded;
  * archives never escape: zip-slip/tar-slip names and links are skipped, an
    extraction never overwrites and never leaves a half-written folder;
  * conversions say `unavailable` (with the fix) instead of failing obscurely.

stdlib unittest only. Run with:
    python3 agent/tests/test_filetools.py
"""
import base64
import gzip
import io
import os
import sqlite3
import sys
import tarfile
import tempfile
import unittest
import zipfile
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent import filetools  # noqa: E402


class _Tmp(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.root = self._td.name

    def tearDown(self):
        self._td.cleanup()

    def write(self, rel, data):
        p = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f:
            f.write(data if isinstance(data, bytes) else data.encode())
        return p


class ReadRange(_Tmp):
    def test_tail_head_and_caps(self):
        self.write("app.log", b"0123456789" * 10)
        r = filetools.fs_read_range(self.root, "app.log", -15, 1000)
        self.assertTrue(r["ok"])
        self.assertEqual((r["size"], r["offset"], r["length"]), (100, 85, 15))
        self.assertEqual(base64.b64decode(r["data"]), b"567890123456789")
        r = filetools.fs_read_range(self.root, "app.log", 10, 5)
        self.assertEqual(base64.b64decode(r["data"]), b"01234")
        r = filetools.fs_read_range(self.root, "app.log", 500, 5)
        self.assertEqual((r["offset"], r["length"]), (100, 0))
        with mock.patch.object(filetools, "MAX_RANGE_BYTES", 7):
            self.assertEqual(filetools.fs_read_range(self.root, "app.log", 0, 1000)["length"], 7)

    def test_containment_and_missing(self):
        self.assertFalse(filetools.fs_read_range(self.root, "../etc/passwd", 0, 10)["ok"])
        r = filetools.fs_read_range(self.root, "nope.log", 0, 10)
        self.assertEqual(r.get("reason"), "missing")


class Sqlite(_Tmp):
    def setUp(self):
        super().setUp()
        self.db = os.path.join(self.root, "data.db")
        conn = sqlite3.connect(self.db)
        conn.executescript("""
            CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, avatar BLOB);
            CREATE INDEX users_name ON users(name);
            CREATE VIEW names AS SELECT name FROM users;
            INSERT INTO users (name, avatar) VALUES ('ada', x'89504e47'), ('bob', NULL);
        """)
        conn.execute("INSERT INTO users (name) VALUES (?)", ("x" * 5000,))
        conn.commit()
        conn.close()
        with open(os.path.join(self.root, "other.db"), "wb") as f:
            f.write(b"")

    def test_schema(self):
        r = filetools.sqlite_schema(self.root, "data.db")
        self.assertTrue(r["ok"], r)
        by = {o["name"]: o for o in r["objects"]}
        self.assertEqual(by["users"]["rows"], 3)
        self.assertEqual([c["name"] for c in by["users"]["columns"]], ["id", "name", "avatar"])
        self.assertTrue(by["users"]["columns"][0]["pk"])
        self.assertEqual(by["names"]["type"], "view")
        self.assertEqual(by["users_name"]["type"], "index")

    def test_query_cells_are_bounded(self):
        r = filetools.sqlite_query(self.root, "data.db", "SELECT * FROM users ORDER BY id", limit=2)
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["columns"], ["id", "name", "avatar"])
        self.assertEqual(r["rows"][0], [1, "ada", {"$blob": 4, "hex": "89504e47"}])
        self.assertTrue(r["truncated"])
        r = filetools.sqlite_query(self.root, "data.db", "SELECT name FROM users WHERE id = ?", [3])
        self.assertEqual(r["rows"][0][0]["length"], 5000)
        self.assertEqual(len(r["rows"][0][0]["$text"]), filetools.SQLITE_CELL_CHARS)

    def test_everything_but_reading_is_refused(self):
        for sql in [
            "DELETE FROM users",
            "INSERT INTO users (name) VALUES ('eve')",
            "UPDATE users SET name = 'x'",
            "DROP TABLE users",
            "CREATE TABLE t (x)",
            f"ATTACH DATABASE '{os.path.join(self.root, 'other.db')}' AS o",
            "PRAGMA user_version = 7",
            "BEGIN",
            "SELECT 1; DELETE FROM users",
        ]:
            r = filetools.sqlite_query(self.root, "data.db", sql)
            self.assertFalse(r["ok"], sql)
        self.assertEqual(filetools.sqlite_query(self.root, "data.db", "SELECT count(*) FROM users")["rows"], [[3]])
        self.assertTrue(filetools.sqlite_query(self.root, "data.db", 'PRAGMA table_info("users")')["ok"])

    def test_not_a_database(self):
        self.write("notes.db", b"just text")
        r = filetools.sqlite_schema(self.root, "notes.db")
        self.assertEqual(r.get("reason"), "format")

    def test_python_without_sqlite3(self):
        # A source-built Python without `_sqlite3` must still boot the daemon
        # (server.py imports filetools); only the SQLite view goes dark.
        import importlib  # noqa: PLC0415
        try:
            with mock.patch.dict(sys.modules, {"_sqlite3": None, "sqlite3": None,
                                               "sqlite3.dbapi2": None}):
                importlib.reload(filetools)
            self.assertIsNone(filetools.sqlite3)
            self.assertEqual(filetools.sqlite_schema(self.root, "data.db").get("reason"), "unavailable")
            self.assertEqual(filetools.sqlite_query(self.root, "data.db", "SELECT 1").get("reason"), "unavailable")
        finally:
            importlib.reload(filetools)
        self.assertIsNotNone(filetools.sqlite3)


class Archives(_Tmp):
    def make_zip(self, rel, members):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            for name, data in members:
                zf.writestr(name, data)
        return self.write(rel, buf.getvalue())

    def test_member_names_cannot_escape(self):
        for bad in ["/etc/passwd", "../x", "a/../../x", "C:/x", "", "a\0b"]:
            self.assertIsNone(filetools.safe_member_path(bad), bad)
        self.assertEqual(filetools.safe_member_path("./a//b/c.txt"), "a/b/c.txt")
        self.assertEqual(filetools.safe_member_path("a\\b.txt"), "a/b.txt")

    def test_zip_list_read_extract(self):
        self.make_zip("pkg/site.zip", [("index.html", "<p>hi</p>"), ("css/a.css", "p{}"), ("../evil.txt", "x")])
        r = filetools.archive_list(self.root, "pkg/site.zip")
        self.assertEqual(r["kind"], "zip")
        self.assertEqual({e["name"] for e in r["entries"]}, {"index.html", "css/a.css", "../evil.txt"})
        r = filetools.archive_read(self.root, "pkg/site.zip", "css/a.css")
        self.assertEqual(base64.b64decode(r["data"]), b"p{}")
        r = filetools.archive_extract(self.root, "pkg/site.zip")
        self.assertTrue(r["ok"], r)
        self.assertEqual((r["dest"], r["files"], r["skipped"]), ("pkg/site", 2, 1))
        with open(os.path.join(self.root, "pkg/site/css/a.css")) as f:
            self.assertEqual(f.read(), "p{}")
        self.assertFalse(os.path.exists(os.path.join(self.root, "evil.txt")))
        # Never over an existing folder, and nothing half-written on refusal.
        r = filetools.archive_extract(self.root, "pkg/site.zip")
        self.assertEqual(r.get("reason"), "exists")
        self.assertEqual(sorted(os.listdir(os.path.join(self.root, "pkg"))), ["site", "site.zip"])

    def test_tar_skips_links_and_bombs_roll_back(self):
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tf:
            data = b"hello"
            info = tarfile.TarInfo("dir/hello.txt")
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
            link = tarfile.TarInfo("dir/passwd")
            link.type = tarfile.SYMTYPE
            link.linkname = "/etc/passwd"
            tf.addfile(link)
        self.write("b.tar.gz", buf.getvalue())
        r = filetools.archive_list(self.root, "b.tar.gz")
        self.assertEqual(r["kind"], "tar")
        self.assertEqual([e["link"] for e in r["entries"] if e["name"] == "dir/passwd"], ["/etc/passwd"])
        with mock.patch.object(filetools, "EXTRACT_MAX_BYTES", 3):
            r = filetools.archive_extract(self.root, "b.tar.gz")
            self.assertFalse(r["ok"])
        self.assertEqual(sorted(os.listdir(self.root)), ["b.tar.gz"])
        r = filetools.archive_extract(self.root, "b.tar.gz")
        self.assertTrue(r["ok"], r)
        self.assertEqual((r["dest"], r["files"], r["skipped"]), ("b", 1, 1))
        self.assertFalse(os.path.lexists(os.path.join(self.root, "b/dir/passwd")))

    def test_gzip_single_file(self):
        self.write("app.log.gz", gzip.compress(b"line\n" * 100))
        r = filetools.archive_list(self.root, "app.log.gz")
        self.assertEqual(r["entries"], [{"name": "app.log", "size": 500, "dir": False, "mtime": None}])
        self.assertEqual(len(base64.b64decode(filetools.archive_read(self.root, "app.log.gz", "")["data"])), 500)

    def test_not_an_archive(self):
        self.write("x.zip", b"nope")
        self.assertEqual(filetools.archive_list(self.root, "x.zip").get("reason"), "format")


class Conversions(_Tmp):
    def test_office_without_libreoffice_says_so(self):
        self.write("deck.pptx", b"PK")
        with mock.patch.object(filetools, "_office_binary", return_value=None):
            r = filetools.convert_pdf(self.root, "deck.pptx")
        self.assertEqual(r["reason"], "unavailable")
        self.assertIn("LibreOffice", r["error"])

    def test_tiff_to_png_when_pillow_is_there(self):
        try:
            from PIL import Image
        except ImportError:
            self.write("a.tiff", b"II*\x00")
            self.assertEqual(filetools.convert_image(self.root, "a.tiff")["reason"], "unavailable")
            return
        buf = io.BytesIO()
        Image.new("RGB", (40, 30), (200, 10, 10)).save(buf, format="TIFF")
        self.write("a.tiff", buf.getvalue())
        r = filetools.convert_image(self.root, "a.tiff")
        self.assertTrue(r["ok"], r)
        self.assertEqual((r["width"], r["height"]), (40, 30))
        self.assertTrue(base64.b64decode(r["data"]).startswith(b"\x89PNG"))


if __name__ == "__main__":
    unittest.main()
