import random

class Board:
    """雷区数据模型"""
    
    # 格子状态常量
    HIDDEN = 0      # 未挖开
    REVEALED = 1    # 已挖开
    FLAGGED = 2     # 已标旗
    
    def __init__(self, rows=9, cols=9, mines=10):
        self.rows = rows
        self.cols = cols
        self.mines = mines
        self.grid = [[self.HIDDEN for _ in range(cols)] for _ in range(rows)]
        self.mine_positions = set()
        self.numbers = [[0 for _ in range(cols)] for _ in range(rows)]
        self.first_click = True  # 首次点击标记
    
    def _is_valid(self, r, c):
        """检查坐标是否在棋盘范围内"""
        return 0 <= r < self.rows and 0 <= c < self.cols
    
    def _get_neighbors(self, r, c):
        """获取周围8个邻居坐标"""
        neighbors = []
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if dr == 0 and dc == 0:
                    continue
                nr, nc = r + dr, c + dc
                if self._is_valid(nr, nc):
                    neighbors.append((nr, nc))
        return neighbors
    
    def place_mines(self, safe_r, safe_c):
        """布雷，确保 safe_r, safe_c 及其周围安全"""
        # 计算安全区域（首次点击位置及其邻居）
        safe_zone = {(safe_r, safe_c)}
        for nr, nc in self._get_neighbors(safe_r, safe_c):
            safe_zone.add((nr, nc))
        
        # 可布雷的位置
        available = [(r, c) for r in range(self.rows) for c in range(self.cols) 
                     if (r, c) not in safe_zone]
        
        # 如果可用位置不够，缩小安全区域
        if len(available) < self.mines:
            available = [(r, c) for r in range(self.rows) for c in range(self.cols) 
                         if (r, c) != (safe_r, safe_c)]
        
        self.mine_positions = set(random.sample(available, self.mines))
        self._calculate_numbers()
        self.first_click = False
    
    def _calculate_numbers(self):
        """计算每个格子周围的雷数"""
        for r in range(self.rows):
            for c in range(self.cols):
                if (r, c) in self.mine_positions:
                    self.numbers[r][c] = -1  # 雷
                else:
                    count = 0
                    for nr, nc in self._get_neighbors(r, c):
                        if (nr, nc) in self.mine_positions:
                            count += 1
                    self.numbers[r][c] = count
    
    def is_mine(self, r, c):
        """判断是否为雷"""
        return (r, c) in self.mine_positions
    
    def get_number(self, r, c):
        """获取数字（-1表示雷）"""
        return self.numbers[r][c]
    
    def get_state(self, r, c):
        """获取格子状态"""
        return self.grid[r][c]
    
    def set_state(self, r, c, state):
        """设置格子状态"""
        self.grid[r][c] = state
    
    def reset(self):
        """重置棋盘"""
        self.grid = [[self.HIDDEN for _ in range(self.cols)] for _ in range(self.rows)]
        self.mine_positions = set()
        self.numbers = [[0 for _ in range(self.cols)] for _ in range(self.rows)]
        self.first_click = True
