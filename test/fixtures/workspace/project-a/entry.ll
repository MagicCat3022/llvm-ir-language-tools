declare i32 @twice(i32)
declare i32 @printf(ptr, ...)
declare void @llvm.assume(i1)

define internal i32 @helper() {
entry:
  ret i32 1
}

define internal i32 @taken() {
entry:
  ret i32 9
}

define i32 @main() {
entry:
  %result = call i32 @twice(i32 21)
  %private = call i32 @helper()
  %printed = call i32 (ptr, ...) @printf(ptr null, i32 %result)
  call void @llvm.assume(i1 true)
  ret i32 %result
}
