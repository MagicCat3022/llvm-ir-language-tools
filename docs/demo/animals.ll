; Objects with a vtable, the way a compiler lowers classes.
%Class_Animal = type { ptr, i32 }
%Class_Dog = type { ptr, i32, i32 }

@animalVTBL = constant [1 x ptr] [ptr @animal_makeNoise]
@dogVTBL = constant [1 x ptr] [ptr @dog_makeNoise]
@woof = private constant [6 x i8] c"Woof\0A\00"
@noise = private constant [5 x i8] c"...\0A\00"

declare i32 @printf(ptr, ...)
declare ptr @malloc(i64)

define void @animal_makeNoise(ptr %this) {
entry:
  call i32 (ptr, ...) @printf(ptr @noise)
  ret void
}

define void @dog_makeNoise(ptr %this) {
entry:
  call i32 (ptr, ...) @printf(ptr @woof)
  ret void
}

define ptr @new_dog(i32 %age) {
entry:
  %dog = call ptr @malloc(i64 16)
  %vtbl_field = getelementptr %Class_Dog, ptr %dog, i32 0, i32 0
  store ptr @dogVTBL, ptr %vtbl_field
  %age_field = getelementptr %Class_Dog, ptr %dog, i32 0, i32 1
  store i32 %age, ptr %age_field
  ret ptr %dog
}

define i32 @main() {
entry:
  %dog_ptr = alloca ptr
  %dog = call ptr @new_dog(i32 3)
  store ptr %dog, ptr %dog_ptr
  %obj = load ptr, ptr %dog_ptr
  %vtbl_field = getelementptr %Class_Dog, ptr %obj, i32 0, i32 0
  %vtbl = load ptr, ptr %vtbl_field
  %method_slot = getelementptr [1 x ptr], ptr %vtbl, i32 0, i32 0
  %method = load ptr, ptr %method_slot
  call void %method(ptr %obj)
  ret i32 0
}
