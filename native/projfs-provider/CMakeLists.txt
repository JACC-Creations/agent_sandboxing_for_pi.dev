cmake_minimum_required(VERSION 3.25)

set(CMAKE_SYSTEM_VERSION 10.0.26100.0 CACHE STRING "Windows SDK version" FORCE)
project(projfs-provider LANGUAGES CXX)

if(NOT WIN32 OR NOT MSVC)
    message(FATAL_ERROR "projfs-provider requires the Microsoft x64 Windows toolchain")
endif()

if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
    message(FATAL_ERROR "projfs-provider must be built for x64")
endif()

add_executable(projfs-provider provider.cpp)
add_executable(launch-supervisor launch-supervisor.cpp)
add_executable(lower-freeze-guard lower-freeze-guard.cpp)
add_executable(generation-supervisor generation-supervisor.cpp)

foreach(Target projfs-provider launch-supervisor lower-freeze-guard generation-supervisor)
    target_compile_features(${Target} PRIVATE cxx_std_20)
    target_compile_definitions(${Target} PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
    target_compile_options(${Target} PRIVATE /W4 /WX /permissive- /EHsc)
    target_link_options(${Target} PRIVATE "/MANIFEST:EMBED" "/MANIFESTINPUT:${CMAKE_CURRENT_SOURCE_DIR}/provider.manifest")
endforeach()

target_link_libraries(projfs-provider PRIVATE ProjectedFSLib Ole32)
