param([string]$Base = 'http://localhost:3101/api')
# POS Server E2E: flujo del container server (login -> caja -> producto -> stock -> turno -> venta -> reporte -> cierre)
$login = Invoke-RestMethod "$Base/auth/login" -Method Post -ContentType 'application/json' -Body '{"email":"admin@pos.com","pin":"1234"}'
$tok = $login.token
$H = @{ Authorization = "Bearer $tok" }
$user = $login.user
Write-Host "## LOGIN $($user.nombre) role=$($user.role)"

$caja = Invoke-RestMethod "$Base/mi/caja?nombre=CAJA-1" -Headers $H
Write-Host "## CAJA $($caja.caja_nombre) id=$($caja.caja_id) suc=$($caja.sucursal_id)"

$turno = Invoke-RestMethod "$Base/turnos" -Method Post -ContentType 'application/json' -Headers $H -Body (@{ usuario_id = $user.id; caja_id = $caja.caja_id; sucursal_id = $caja.sucursal_id; monto_apertura = 500 } | ConvertTo-Json)
Write-Host "## TURNO ABIERTO estado=$($turno.estado)"

$p = Invoke-RestMethod "$Base/productos" -Method Post -ContentType 'application/json' -Headers $H -Body (@{ sku = 'E2E001'; barcode = '779999999001'; nombre = 'Producto E2E'; precio = 100; impuesto = 0; stock_central = 50 } | ConvertTo-Json)
$prodId = $p.id
$stockBody = @{ producto_id = $prodId; sucursal_id = $caja.sucursal_id; cantidad = 50; minimo = 5; maximo = 100 } | ConvertTo-Json
Invoke-RestMethod "$Base/productos/$prodId/stock" -Method Post -ContentType 'application/json' -Headers $H -Body $stockBody | Out-Null
Write-Host "## PRODUCTO $prodId stock actualizado"

$ventaBody = @{ turno_id = $turno.id; caja_id = $caja.caja_id; sucursal_id = $caja.sucursal_id; usuario_id = $user.id; metodo_pago = 'EFECTIVO'; detalles = @(@{ producto_id = $prodId; cantidad = 2; precio_unitario = 100; impuesto = 0 }) } | ConvertTo-Json -Depth 5
$venta = Invoke-RestMethod "$Base/ventas" -Method Post -ContentType 'application/json' -Headers $H -Body $ventaBody
Write-Host "## VENTA id=$($venta.id) total=$($venta.total)"

$det = Invoke-RestMethod "$Base/turnos/$($turno.id)" -Headers $H
Write-Host "## TURNO detalle: ventas=$($det.ventas.Count) totalVentas=$($det.totalVentas) efectivo=$($det.ventasEfectivo) movs=$($det.movimientos.Count)"

$cd = Invoke-RestMethod "$Base/turnos/$($turno.id)/cerrar" -Method Post -ContentType 'application/json' -Headers $H -Body (@{ monto_contado = 700 } | ConvertTo-Json)
Write-Host "## CIERRE: esperado=$($cd.esperado) flag=$($cd.flagged)"

$productos = Invoke-RestMethod "$Base/productos?activo=true&limit=10" -Headers $H
Write-Host "## PRODUCTOS activos=$($productos.Count)"

$list = Invoke-RestMethod "$Base/turnos?limit=5" -Headers $H
Write-Host "## LISTA(completo): [$($list.Count)] nombre=$($list[0].caja_nombre) ventas=$($list[0].ventas_count) totalVentas=$($list[0].totalVentas) nombreUsr=$($list[0].usuario_nombre)"

$venc = Invoke-RestMethod "$Base/productos/vencimientos?dias=30" -Headers $H
Write-Host "## VENCIMIENTOS endpoint ok (antes de /:id) -> registros=$($venc.Count)"