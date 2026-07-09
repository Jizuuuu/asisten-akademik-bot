require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const cron = require('node-cron');
const fs = require('fs');
const axios = require('axios');
const express = require('express'); // Tambahan Express

// ==========================================
// TRIK WEB SERVER UNTUK RENDER GRATIS
// ==========================================
const app = express();
app.get('/', (req, res) => res.send('Bot Asisten Akademik Sedang Menyala! 🤖'));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server web port ${port} siap (Render Bypassed)`));

// Membaca file jadwal data.json
const localData = JSON.parse(fs.readFileSync('./data.json', 'utf8'));

// Menginisialisasi Client Discord
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ]
});

// ==========================================
// FUNGSI LOGIN IGRACIAS (mengembalikan cookies)
// ==========================================
async function loginIGracias() {
    const session = axios.create({
        baseURL: 'https://igracias.telkomuniversity.ac.id',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        maxRedirects: 10,
    });

    let cookies = '';

    // Ambil cookie awal
    const loginPage = await session.get('/', { validateStatus: () => true });
    if (loginPage.headers['set-cookie']) {
        cookies = loginPage.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
    }

    // Login via POST
    const loginResponse = await session.post('/',
        new URLSearchParams({
            textUsername: process.env.IGRACIAS_USERNAME,
            textPassword: process.env.IGRACIAS_PASSWORD,
            submit: 'Login'
        }).toString(),
        {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': cookies,
                'Referer': 'https://igracias.telkomuniversity.ac.id/',
            },
            maxRedirects: 10,
            validateStatus: () => true,
        }
    );

    if (loginResponse.headers['set-cookie']) {
        const newCookies = loginResponse.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
        cookies = cookies ? `${cookies}; ${newCookies}` : newCookies;
    }

    const loginHtml = loginResponse.data;
    if (loginHtml.includes('textUsername') && loginHtml.includes('textPassword') && !loginHtml.includes('Keluar')) {
        return null; // Login gagal
    }

    return cookies;
}

// ==========================================
// FUNGSI AMBIL DATA NILAI DARI IGRACIAS
// ==========================================
async function scrapeNilaiiGracias() {
    try {
        console.log('1. Login ke iGracias...');
        const cookies = await loginIGracias();
        if (!cookies) {
            console.log('   ❌ Login gagal!');
            return null;
        }
        console.log('   ✅ Login berhasil!');

        // Buka halaman KHS dulu (wajib untuk set sesi)
        console.log('2. Membuka halaman KHS...');
        const khsPage = await axios.get('https://igracias.telkomuniversity.ac.id/score/index.php?pageid=11', {
            headers: { 'Cookie': cookies, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            validateStatus: () => true,
        });
        
        let updatedCookies = cookies;
        if (khsPage.headers['set-cookie']) {
            const khsCookies = khsPage.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
            updatedCookies = `${cookies}; ${khsCookies}`;
        }

        // Request AJAX endpoint
        console.log('3. Mengambil data nilai...');
        const nilaiResponse = await axios.get('https://igracias.telkomuniversity.ac.id/libraries/ajax/ajax.score.php', {
            params: { act: 'viewCompleteScoreStudent', iDisplayStart: 0, iDisplayLength: 100, sEcho: 1 },
            headers: {
                'Cookie': updatedCookies,
                'Referer': 'https://igracias.telkomuniversity.ac.id/score/index.php?pageid=11',
                'X-Requested-With': 'XMLHttpRequest',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
            validateStatus: () => true,
        });

        let nilaiData = nilaiResponse.data;

        // Fallback path jika 404
        if (typeof nilaiData === 'string' && (nilaiData.includes('404') || nilaiData.includes('permission'))) {
            console.log('   ⚠️ Path pertama gagal, mencoba alternatif...');
            const altResponse = await axios.get('https://igracias.telkomuniversity.ac.id/score/libraries/ajax/ajax.score.php', {
                params: { act: 'viewCompleteScoreStudent', iDisplayStart: 0, iDisplayLength: 100, sEcho: 1 },
                headers: {
                    'Cookie': updatedCookies,
                    'Referer': 'https://igracias.telkomuniversity.ac.id/score/index.php?pageid=11',
                    'X-Requested-With': 'XMLHttpRequest',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                },
                validateStatus: () => true,
            });
            nilaiData = altResponse.data;
        }

        fs.writeFileSync('debug_nilai.json', JSON.stringify(nilaiData, null, 2));

        // Parse data
        console.log('4. Memproses data nilai...');
        const listNilai = [];

        if (nilaiData && nilaiData.aaData && nilaiData.aaData.length > 0) {
            nilaiData.aaData.forEach(row => {
                if (row[1] && row[1].length > 2) {
                    listNilai.push({
                        kode: row[0] || '',
                        matkul: row[1] || '',
                        sks: row[2] || '',
                        periode: row[3] || '',
                        nilai: row[4] || '-',
                        recordId: row[7] || '',
                    });
                }
            });
        }

        console.log(`   ✅ Ditemukan ${listNilai.length} mata kuliah.`);
        return { listNilai, cookies: updatedCookies };

    } catch (error) {
        console.error('Terjadi error saat scraping iGracias:', error.message);
        return null;
    }
}

// ==========================================
// FUNGSI AMBIL KOMPONEN NILAI PER MATKUL
// (Tugas, UTS, UAS, dll + bobot & skor)
// ==========================================
async function getKomponenNilai(cookies, recordId) {
    try {
        const response = await axios.post(
            'https://igracias.telkomuniversity.ac.id/libraries/ajax/ajax.score.php?act=getcomponentscore',
            new URLSearchParams({ rId: recordId }).toString(),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Cookie': cookies,
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': 'https://igracias.telkomuniversity.ac.id/score/index.php?pageid=11',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                },
                validateStatus: () => true,
            }
        );

        if (Array.isArray(response.data) && response.data.length > 0) {
            let totalBobotTerisi = 0;
            let totalSkor = 0;
            const komponen = response.data.map(k => {
                const nama = k.COMPONENTNAME || k.componentname || '-';
                const persen = parseFloat(k.PERCENTAGE || k.percentage || 0);
                const skor = parseFloat(k.TSCORE || k.tscore || 0);
                if (skor > 0) {
                    totalBobotTerisi += persen;
                    totalSkor += (skor * persen) / 100;
                }
                return { nama, persen, skor };
            });
            const rataRata = totalBobotTerisi > 0 ? ((totalSkor / totalBobotTerisi) * 100).toFixed(1) : '-';
            return { komponen, rataRata };
        }
        return null;
    } catch (e) {
        return null;
    }
}

// ==========================================
// KETIKA BOT BERHASIL ONLINE
// ==========================================
client.once('ready', () => {
    console.log(`🤖 Bot Asisten Akademik berhasil online sebagai ${client.user.tag}!`);

    // ==========================================
    // PENGINGAT OTOMATIS (CRON JOB)
    // Berjalan setiap Minggu - Kamis pukul 20:00 WIB (8 Malam)
    // ==========================================
    cron.schedule('0 20 * * 0-4', () => {
        const CHANNEL_ID = 'MASUKKAN_ID_CHANNEL_DISCORD_MU_DI_SINI';
        const channel = client.channels.cache.get(CHANNEL_ID);

        if (!channel) return console.log('Saluran pengingat tidak ditemukan.');

        const namaHari = ['minggu', 'senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu'];
        const besokIdx = (new Date().getDay() + 1) % 7;
        const hariBesok = namaHari[besokIdx];
        const jadwalBesok = localData.jadwal[hariBesok];

        if (jadwalBesok && jadwalBesok.length > 0) {
            let pesan = `⏰ **PENGINGAT KULIAH BESOK (${hariBesok.toUpperCase()})**\n\n`;
            jadwalBesok.forEach(m => {
                pesan += `📖 **${m.matkul}**\n   └ Jam: ${m.jam}\n   └ Ruang: ${m.ruang}\n\n`;
            });
            channel.send(pesan);
        } else {
            channel.send(`🎉 **Besok (${hariBesok.toUpperCase()}) kamu tidak ada kelas kuliah!** Nikmati istirahatmu.`);
        }
    });
});

// ==========================================
// MERESPON CHAT DI DISCORD
// ==========================================
client.on('messageCreate', async (message) => {
    console.log(`[LOG] Ada pesan masuk: "${message.content}" dari ${message.author.tag}`);

    if (message.author.bot) return;

    const command = message.content.toLowerCase();

    // 1. Fitur !jadwal
    if (command === '!jadwal') {
        const namaHari = ['minggu', 'senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu'];
        const hariIni = namaHari[new Date().getDay()];
        const jadwalHariIni = localData.jadwal[hariIni];

        if (jadwalHariIni && jadwalHariIni.length > 0) {
            let balasan = `📅 **Jadwal Kuliah Hari Ini (${hariIni.toUpperCase()}):**\n\n`;
            jadwalHariIni.forEach(m => {
                balasan += `• **${m.matkul}** (${m.jam}) - Ruang ${m.ruang}\n`;
            });
            message.reply(balasan);
        } else {
            message.reply(`Hari ini (${hariIni.toUpperCase()}) tidak ada jadwal kuliah. Istirahat yang cukup ya! 😴`);
        }
    }

    // 2. Fitur !nilai (dengan pilihan semester + detail komponen)
    if (command === '!nilai') {
        const daftarSemester = [
            { no: 1, label: 'Semester 1 — 2024/2025 Ganjil',  kode: '2425/1' },
            { no: 2, label: 'Semester 2 — 2024/2025 Genap',   kode: '2425/2' },
            { no: 3, label: 'Semester 3 — 2025/2026 Ganjil',  kode: '2526/1' },
            { no: 4, label: 'Semester 4 — 2025/2026 Genap',   kode: '2526/2' },
            { no: 5, label: 'Semester 5 — 2026/2027 Ganjil',  kode: '2627/1' },
            { no: 6, label: 'Semua Semester',                  kode: 'semua'  },
        ];

        let pilihanMenu = '📚 **Mau lihat nilai semester berapa?**\n\n';
        daftarSemester.forEach(s => {
            pilihanMenu += `**${s.no}.** ${s.label}\n`;
        });
        pilihanMenu += '\n_Balas dengan angka (1-6) dalam 30 detik._';

        const menuMessage = await message.reply(pilihanMenu);

        const filter = m => m.author.id === message.author.id && /^[1-6]$/.test(m.content.trim());

        try {
            const collected = await message.channel.awaitMessages({
                filter, max: 1, time: 30000, errors: ['time']
            });

            const pilihan = parseInt(collected.first().content.trim());
            const semesterDipilih = daftarSemester.find(s => s.no === pilihan);

            const statusMessage = await message.reply(`⏳ Mengambil nilai **${semesterDipilih.label}** dari iGracias...`);
            const result = await scrapeNilaiiGracias();

            if (result && result.listNilai.length > 0) {
                const { listNilai: dataNilai, cookies } = result;
                const bobotNilai = { 'A': 4, 'AB': 3.5, 'B+': 3.5, 'B': 3, 'BC': 2.5, 'B-': 2.5, 'C+': 2.5, 'C': 2, 'C-': 1.5, 'D': 1, 'E': 0, 'T': 0 };

                const hitungIP = (listMK) => {
                    let totalSKS = 0, totalBobot = 0;
                    listMK.forEach(n => {
                        const sks = parseInt(n.sks) || 0;
                        const bobot = bobotNilai[n.nilai] !== undefined ? bobotNilai[n.nilai] : 0;
                        totalSKS += sks;
                        totalBobot += sks * bobot;
                    });
                    return { totalSKS, ip: totalSKS > 0 ? (totalBobot / totalSKS).toFixed(2) : '-' };
                };

                let nilaiFiltered = semesterDipilih.kode === 'semua'
                    ? dataNilai
                    : dataNilai.filter(n => n.periode === semesterDipilih.kode);

                if (nilaiFiltered.length > 0) {
                    let balasan = '';

                    if (semesterDipilih.kode === 'semua') {
                        // ===== REKAP SEMUA SEMESTER =====
                        const { totalSKS, ip: ipk } = hitungIP(nilaiFiltered);
                        balasan += `📊 **Rekap Nilai Seluruh Semester**\n`;
                        balasan += `🎓 **IPK Kumulatif: ${ipk}** | Total: ${totalSKS} SKS | ${nilaiFiltered.length} MK\n\n`;

                        const grouped = {};
                        nilaiFiltered.forEach(n => {
                            if (!grouped[n.periode]) grouped[n.periode] = [];
                            grouped[n.periode].push(n);
                        });

                        Object.keys(grouped).sort().forEach(periode => {
                            const mkSemester = grouped[periode];
                            const { totalSKS: sksSmt, ip: ipSmt } = hitungIP(mkSemester);
                            const semLabel = daftarSemester.find(s => s.kode === periode)?.label || periode;
                            balasan += `━━━ **${semLabel}** ━━━\n`;
                            balasan += `📈 IP: **${ipSmt}** | ${sksSmt} SKS | ${mkSemester.length} MK\n`;
                            mkSemester.forEach(n => {
                                balasan += `  🔸 ${n.matkul} — **${n.nilai}** (${n.sks} SKS)\n`;
                            });
                            balasan += '\n';
                        });

                    } else {
                        // ===== 1 SEMESTER + DETAIL KOMPONEN =====
                        const { totalSKS, ip } = hitungIP(nilaiFiltered);
                        balasan += `📊 **${semesterDipilih.label}** (${nilaiFiltered.length} MK)\n`;
                        balasan += `📈 **IP Semester: ${ip}** | Total: ${totalSKS} SKS\n\n`;

                        for (const n of nilaiFiltered) {
                            // Ambil detail komponen per matkul
                            const detail = await getKomponenNilai(cookies, n.recordId);

                            if (detail && detail.komponen.length > 0) {
                                balasan += `\n**📖 ${n.matkul}** (\`${n.kode}\` | ${n.sks} SKS)\n`;
                                balasan += `Nilai: **${n.nilai}** | Rata-rata: **${detail.rataRata}**\n`;
                                detail.komponen.forEach((k, idx) => {
                                    const isLast = idx === detail.komponen.length - 1;
                                    const branch = isLast ? ' └─' : ' ├─';
                                    const skorText = k.skor > 0 ? k.skor : '-';
                                    balasan += `${branch} ${k.nama} (${k.persen}%): **${skorText}**\n`;
                                });
                            } else {
                                balasan += `\n**📖 ${n.matkul}** (\`${n.kode}\` | ${n.sks} SKS)\n`;
                                balasan += `Nilai: **${n.nilai}**\n`;
                            }
                        }
                    }

                    // Discord max 2000 karakter
                    if (balasan.length > 1900) {
                        balasan = balasan.substring(0, 1900) + '\n\n... _(terpotong, terlalu panjang)_';
                    }
                    statusMessage.edit(balasan);
                } else {
                    statusMessage.edit(`📭 Belum ada data nilai untuk **${semesterDipilih.label}**.`);
                }
            } else {
                statusMessage.edit('❌ Gagal mengambil data nilai. Pastikan username/password di file `.env` sudah benar atau iGracias sedang tidak down.');
            }
        } catch (err) {
            menuMessage.edit('⏰ Waktu habis! Kamu tidak memilih semester dalam 30 detik. Ketik `!nilai` lagi ya.');
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
