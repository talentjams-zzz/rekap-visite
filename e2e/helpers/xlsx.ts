// Synthetic fixture builders for e2e (no real PHI ever enters the suite).
import XLSX from 'xlsx';
import path from 'node:path';

export interface RegPatient {
  mr: string;
  nama: string;
  tglReg: string; // "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS"
  umur?: string;
  kamar?: string;
  bed?: string;
  dokter?: string;
}

/**
 * Registry file in the exact column layout of the hospital export
 * (same as v1's test fixtures). Filename: {facility}-{DD-MM-YY}.xlsx.
 */
export function buildRegistryFile(
  dir: string,
  facility: string,
  ddmmyy: string,
  patients: RegPatient[],
): string {
  const rows: unknown[][] = [
    ['Daftar Pasien Rawat Inap'],
    [
      '', 'Tgl Registrasi', 'No Registrasi', 'Flag', 'No. Rekam Medis', 'EMR 2.1',
      'Nama Pasien', 'Tgl Lahir', 'Umur', 'Dokter', 'Dokter Tambahan', 'Jenis Kelamin',
      'Tipe Pembayaran', 'Jenis Peserta', 'Kelas', 'Kamar', 'Bed', 'Lama Rawat',
      'Kondisi Klinis', 'Verif Farmasi',
    ],
    [`Ruangan Ruang Rawat Nusa Indah (Jumlah: ${patients.length})`],
    ...patients.map((p, i) => [
      '', p.tglReg, String(900000000 + i), '', p.mr, '', p.nama, '01-01-1990',
      p.umur ?? '36 thn', p.dokter ?? 'dr. Test', '', 'LAKI-LAKI', 'BPJS',
      'PEKERJA MANDIRI', 'Kelas III', p.kamar ?? '101', p.bed ?? String(i + 1), '',
      'HIJAU', '✘',
    ]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const p = path.join(dir, `${facility}-${ddmmyy}.xlsx`);
  XLSX.writeFile(wb, p);
  return p;
}

export interface LabTestIn {
  nama: string;
  hasil: string;
  komentar?: string;
  normal?: string;
  satuan?: string;
  keterangan?: string;
  tanggal: string;
}

export interface LabSection {
  jenis: string;
  tests: LabTestIn[];
}

/** lab-{MR}.xlsx with the "Nama Pemeriksaan" header + Jenis section rows. */
export function buildLabFile(dir: string, mr: string, sections: LabSection[]): string {
  const rows: unknown[][] = [
    ['Nama Pemeriksaan', 'Hasil Pemeriksaan', 'Komentar', 'Nilai Normal', 'Satuan', 'Keterangan', 'Tanggal Hasil'],
  ];
  for (const s of sections) {
    rows.push([`Jenis: ${s.jenis}`]);
    for (const t of s.tests) {
      rows.push([t.nama, t.hasil, t.komentar ?? '', t.normal ?? '', t.satuan ?? '', t.keterangan ?? '', t.tanggal]);
    }
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Hasil');
  const p = path.join(dir, `lab-${mr}.xlsx`);
  XLSX.writeFile(wb, p);
  return p;
}
