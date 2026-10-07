// 站点通用交互: 卡片与区块的平滑淡入
document.addEventListener('DOMContentLoaded', () => {
    const targets = document.querySelectorAll('.card, .mixed-layout, .section-title');
    targets.forEach(el => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(16px)';
        el.style.transition = 'opacity .6s ease, transform .6s ease';
    });
    const io = new IntersectionObserver((entries) => {
        entries.forEach(e => {
            if (e.isIntersecting) {
                e.target.style.opacity = '1';
                e.target.style.transform = 'none';
                io.unobserve(e.target);
            }
        });
    }, { threshold: 0.12 });
    targets.forEach(el => io.observe(el));
});
