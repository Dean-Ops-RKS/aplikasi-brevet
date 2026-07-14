const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const path = require('path');
const cors = require('cors');

const app = express();

// Koneksi ke Postgres pakai DATABASE_URL yang otomatis disediakan Railway
// (pastikan variabel DATABASE_URL sudah di-Reference ke service Postgres kamu)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(cors()); // Mengizinkan Netlify / domain lain mengakses backend ini

// Mengatur batas ukuran data agar bisa menerima file gambar berukuran besar
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Inisialisasi Database
async function initDb() {
    await pool.query(`CREATE TABLE IF NOT EXISTS sertifikat (
        id SERIAL PRIMARY KEY,
        nama TEXT,
        divisi TEXT,
        pangkat TEXT,
        brevet TEXT,
        file_sertifikat TEXT,
        status TEXT DEFAULT 'pending'
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS anggota (
        nama TEXT PRIMARY KEY,
        divisi TEXT,
        pangkat TEXT
    )`);

    // Migrasi data lama: isi tabel anggota dari data sertifikat yang sudah ada,
    // pakai baris dengan id TERBESAR (pengajuan terbaru) per nama sebagai acuan.
    await pool.query(`INSERT INTO anggota (nama, divisi, pangkat)
            SELECT nama, divisi, pangkat FROM sertifikat s1
            WHERE s1.id = (SELECT MAX(s2.id) FROM sertifikat s2 WHERE s2.nama = s1.nama)
            ON CONFLICT (nama) DO NOTHING`);

    console.log('Database Postgres siap digunakan');
}

initDb().catch(err => console.error('Gagal inisialisasi database:', err.message));

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
app.get('/api/sertifikat', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM sertifikat ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Proses Ajukan Berkas dari Customer
app.post('/api/upload', async (req, res) => {
    const { nama, divisi, pangkat, brevet, file_sertifikat } = req.body;

    if (!nama || !pangkat || !brevet || !file_sertifikat) {
        return res.status(400).json({ error: "Semua formulir dan data berkas wajib diisi lengkap" });
    }

    try {
        // Perbarui/insert data anggota (nama, divisi, pangkat) dengan nilai TERBARU
        await pool.query(
            `INSERT INTO anggota (nama, divisi, pangkat) VALUES ($1, $2, $3)
             ON CONFLICT (nama) DO UPDATE SET divisi = excluded.divisi, pangkat = excluded.pangkat`,
            [nama, divisi || '-', pangkat]
        );

        const result = await pool.query(
            `INSERT INTO sertifikat (nama, divisi, pangkat, brevet, file_sertifikat, status)
             VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING id`,
            [nama, divisi || '-', pangkat, brevet, file_sertifikat]
        );

        res.json({ id: result.rows[0].id, message: "Pengajuan berhasil dikirim" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Perbarui Status Verifikasi Dokumen (Setujui / Tolak)
app.post('/api/update-status', async (req, res) => {
    const { id, status } = req.body;

    if (!id || !status) {
        return res.status(400).json({ error: "id dan status wajib diisi" });
    }
    if (!['pending', 'approved', 'rejected'].includes(status)) {
        return res.status(400).json({ error: "Nilai status tidak valid" });
    }

    try {
        const result = await pool.query('UPDATE sertifikat SET status = $1 WHERE id = $2', [status, id]);
        if (result.rowCount === 0) return res.status(404).json({ error: "Data dengan id tersebut tidak ditemukan" });
        res.json({ success: true, message: "Status berkas berhasil diperbarui" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Ambil Daftar Seluruh Anggota (data pangkat/divisi terkini)
app.get('/api/anggota', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM anggota ORDER BY nama ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Admin update manual pangkat/divisi seorang anggota (mis. kenaikan pangkat)
app.post('/api/admin/update-anggota', async (req, res) => {
    const { nama, divisi, pangkat } = req.body;
    if (!nama || !pangkat) {
        return res.status(400).json({ error: "Nama dan pangkat wajib diisi" });
    }

    try {
        await pool.query(
            `INSERT INTO anggota (nama, divisi, pangkat) VALUES ($1, $2, $3)
             ON CONFLICT (nama) DO UPDATE SET divisi = excluded.divisi, pangkat = excluded.pangkat`,
            [nama, divisi || '-', pangkat]
        );
        res.json({ success: true, message: "Data anggota berhasil diperbarui" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Hapus Satu Item Pengajuan Brevet
app.delete('/api/sertifikat/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query('DELETE FROM sertifikat WHERE id = $1', [id]);
        if (result.rowCount === 0) return res.status(404).json({ error: "Data dengan id tersebut tidak ditemukan" });
        res.json({ success: true, message: "Data berhasil dihapus" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Validasi dan Pembuatan Kartu Kemeja Anggota
app.get('/api/kartu/:nama', async (req, res) => {
    const namaUser = req.params.nama;

    try {
        const anggotaResult = await pool.query('SELECT nama, divisi, pangkat FROM anggota WHERE nama = $1', [namaUser]);
        const anggotaRow = anggotaResult.rows[0];
        if (!anggotaRow) return res.status(404).json({ error: "Anggota tidak ditemukan" });

        const sertifikatResult = await pool.query(
            `SELECT brevet FROM sertifikat WHERE nama = $1 AND status = 'approved'`,
            [namaUser]
        );

        const kartu = {
            nama: anggotaRow.nama,
            divisi: anggotaRow.divisi,
            pangkat: anggotaRow.pangkat,
            brevets: sertifikatResult.rows.map(r => r.brevet)
        };
        res.json(kartu);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server berjalan di port ${PORT}`);
});