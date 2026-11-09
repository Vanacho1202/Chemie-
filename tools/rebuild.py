import zipfile, sys
src, dst, loader, app = sys.argv[1:5]
zin = zipfile.ZipFile(src)
zout = zipfile.ZipFile(dst, 'w')
for info in zin.infolist():
    n = info.filename
    if n.startswith('META-INF/') or n in ('assets/index.html', 'assets/app.html'):
        continue
    data = zin.read(n)
    zi = zipfile.ZipInfo(n, date_time=(2026, 11, 9, 12, 0, 0))
    zi.compress_type = info.compress_type
    zi.external_attr = info.external_attr
    zout.writestr(zi, data)
for name, path in (('assets/index.html', loader), ('assets/app.html', app)):
    zi = zipfile.ZipInfo(name, date_time=(2026, 11, 9, 12, 0, 0)); zi.compress_type = zipfile.ZIP_DEFLATED
    zout.writestr(zi, open(path, 'rb').read())
zout.close()
for i in zipfile.ZipFile(dst).infolist(): print(i.filename, 'STORED' if i.compress_type == 0 else 'DEFLATED', i.file_size)
