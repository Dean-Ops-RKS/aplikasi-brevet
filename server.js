const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const db = new sqlite3.Database('./database.db');
const cors = require('cors');
app.use(cors()); // Mengizinkan Netlify / domain lain mengakses backend ini

// Mengatur batas ukuran data agar bisa menerima file gambar berukuran besar
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Inisialisasi Database dengan kolom teks khusus penyimpan file gambar (Base64)
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS sertifikat (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nama TEXT,
        divisi TEXT,
        pangkat TEXT,
        brevet TEXT,
        file_sertifikat TEXT,
        status TEXT DEFAULT 'pending'
    )`);

    // Migrasi otomatis: kalau tabel lama belum punya kolom "divisi", tambahkan.
    // (SQLite tidak punya "ADD COLUMN IF NOT EXISTS", jadi kita cek dulu manual)
    db.all(`PRAGMA table_info(sertifikat)`, [], (err, columns) => {
        if (err) return console.error('Gagal cek struktur tabel:', err.message);
        const adaKolomDivisi = columns.some(c => c.name === 'divisi');
        if (!adaKolomDivisi) {
            db.run(`ALTER TABLE sertifikat ADD COLUMN divisi TEXT`, (errAlter) => {
                if (errAlter) console.error('Gagal migrasi kolom divisi:', errAlter.message);
                else console.log('Migrasi: kolom "divisi" berhasil ditambahkan ke tabel sertifikat');
            });
        }
    });

    // Tabel "anggota" = SUMBER TUNGGAL untuk data pangkat & divisi seseorang.
    // Ini memperbaiki bug: dulu pangkat disimpan per-baris-brevet, jadi kartu
    // bisa menampilkan pangkat lama yang sudah tidak berlaku.
    db.run(`CREATE TABLE IF NOT EXISTS anggota (
        nama TEXT PRIMARY KEY,
        divisi TEXT,
        pangkat TEXT
    )`);

    // Migrasi data lama: isi tabel anggota dari data sertifikat yang sudah ada,
    // pakai baris dengan id TERBESAR (pengajuan terbaru) per nama sebagai acuan.
    db.run(`INSERT OR IGNORE INTO anggota (nama, divisi, pangkat)
            SELECT nama, divisi, pangkat FROM sertifikat s1
            WHERE s1.id = (SELECT MAX(s2.id) FROM sertifikat s2 WHERE s2.nama = s1.nama)`,
        (errMigrasi) => {
            if (errMigrasi) console.error('Gagal migrasi data ke tabel anggota:', errMigrasi.message);
        });
});

// Routing Halaman Utama
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Routing Halaman Admin
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// API: Autentikasi Login Admin
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'admin' && password === 'al') {
        res.json({ success: true, message: "Login Berhasil" });
    } else {
        res.status(401).json({ success: false, message: "Username atau Password Salah" });
    }
});

// API: Memuat Seluruh Data Sertifikat
app.get('/api/sertifikat', (req, res) => {
    db.all('SELECT * FROM sertifikat ORDER BY id DESC', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// API: Proses Ajukan Berkas dari Customer (Metode Base64 yang Stabil)
app.post('/api/upload', (req, res) => {
    const { nama, divisi, pangkat, brevet, file_sertifikat } = req.body;

    if (!nama || !pangkat || !brevet || !file_sertifikat) {
        return res.status(400).json({ error: "Semua formulir dan data berkas wajib diisi lengkap" });
    }

    // Perbarui/insert data anggota (nama, divisi, pangkat) dengan nilai TERBARU
    // dari formulir ini. Ini yang membuat pangkat di kartu selalu up-to-date
    // begitu anggota mengajukan brevet baru dengan pangkat barunya.
    db.run(`INSERT INTO anggota (nama, divisi, pangkat) VALUES (?, ?, ?)
            ON CONFLICT(nama) DO UPDATE SET divisi = excluded.divisi, pangkat = excluded.pangkat`,
        [nama, divisi || '-', pangkat], (errAnggota) => {
            if (errAnggota) console.error('Gagal update data anggota:', errAnggota.message);
        });

    db.run(`INSERT INTO sertifikat (nama, divisi, pangkat, brevet, file_sertifikat, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
    [nama, divisi || '-', pangkat, brevet, file_sertifikat], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ id: this.lastID, message: "Pengajuan berhasil dikirim" });
    });
});

// API: Perbarui Status Verifikasi Dokumen (Setujui / Tolak)
app.post('/api/update-status', (req, res) => {
    const { id, status } = req.body;

    if (!id || !status) {
        return res.status(400).json({ error: "id dan status wajib diisi" });
    }
    if (!['pending', 'approved', 'rejected'].includes(status)) {
        return res.status(400).json({ error: "Nilai status tidak valid" });
    }

    db.run(`UPDATE sertifikat SET status = ? WHERE id = ?`, [status, id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: "Data dengan id tersebut tidak ditemukan" });
        res.json({ success: true, message: "Status berkas berhasil diperbarui" });
    });
});

// API: Ambil Daftar Seluruh Anggota (data pangkat/divisi terkini)
app.get('/api/anggota', (req, res) => {
    db.all(`SELECT * FROM anggota ORDER BY nama ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// API: Admin update manual pangkat/divisi seorang anggota (mis. kenaikan pangkat)
app.post('/api/admin/update-anggota', (req, res) => {
    const { nama, divisi, pangkat } = req.body;
    if (!nama || !pangkat) {
        return res.status(400).json({ error: "Nama dan pangkat wajib diisi" });
    }
    db.run(`INSERT INTO anggota (nama, divisi, pangkat) VALUES (?, ?, ?)
            ON CONFLICT(nama) DO UPDATE SET divisi = excluded.divisi, pangkat = excluded.pangkat`,
        [nama, divisi || '-', pangkat], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, message: "Data anggota berhasil diperbarui" });
        });
});

// API: Hapus Satu Item Pengajuan Brevet
app.delete('/api/sertifikat/:id', (req, res) => {
    const { id } = req.params;

    db.run(`DELETE FROM sertifikat WHERE id = ?`, [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: "Data dengan id tersebut tidak ditemukan" });
        res.json({ success: true, message: "Data berhasil dihapus" });
    });
});

// API: Validasi dan Pembuatan Kartu Kemeja Anggota
app.get('/api/kartu/:nama', (req, res) => {
    const namaUser = req.params.nama;

    // Pangkat & divisi SELALU diambil dari tabel anggota (data terbaru/terkini),
    // bukan dari baris brevet, supaya kenaikan pangkat langsung tercermin di kartu.
    db.get(`SELECT nama, divisi, pangkat FROM anggota WHERE nama = ?`, [namaUser], (errAnggota, anggotaRow) => {
        if (errAnggota) return res.status(500).json({ error: errAnggota.message });
        if (!anggotaRow) return res.status(404).json({ error: "Anggota tidak ditemukan" });

        db.all(`SELECT brevet FROM sertifikat WHERE nama = ? AND status = 'approved'`, [namaUser], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });

            const kartu = {
                nama: anggotaRow.nama,
                divisi: anggotaRow.divisi,
                pangkat: anggotaRow.pangkat,
                brevets: rows.map(r => r.brevet)
            };
            res.json(kartu);
        });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server berjalan di port ${PORT}`);
});